/*
  ESP32 PLC trainer firmware
  --------------------------
  Upload this sketch ONCE with the Arduino IDE. After that, ladder programs are sent from
  the web app over the same USB cable and stored in the ESP32's flash memory.

  Board:    "ESP32 Dev Module"  (ESP32-WROOM-32, 30-pin devkit)
  Library:  U8g2 by olikraus (Library Manager). Preferences and Wire come with the ESP32 core.

  Wiring (see the schematic):
    Inputs  I1..I4  : GPIO34, 35, 36, 39   (from the NOYITO opto module OUT1..OUT4)
    Relays  Q1..Q4  : GPIO25, 26, 27, 33   (to relay module IN1..IN4, active LOW)
    OLED 1.3" SH1106: SDA GPIO21, SCL GPIO22 (I2C address 0x3C)
*/
#include <Arduino.h>
#include <Preferences.h>
#include <Wire.h>
#include <U8g2lib.h>
#include "plc_engine.h"

// ---------------- settings you may need to change ----------------
#define INPUT_ACTIVE_LOW   1   // 1: module output goes LOW when 24 V is applied. If I1..I4 look inverted
                               //    in the app (lit when the switch is OFF), change this to 0.
#define RELAY_ACTIVE_LOW   1   // 1: relay module energises when its IN pin is LOW (JD-VCC modules)
#define USE_OLED           1   // 0 if no display is fitted
#define SCAN_MS            10  // scan cycle
// -----------------------------------------------------------------

static const uint8_t IN_PIN[4]  = {34, 35, 36, 39};
static const uint8_t OUT_PIN[4] = {25, 26, 27, 33};

PlcEngine engine;
PlcLink   plcLink;
Preferences prefs;
volatile bool plcRun = false;
volatile bool monitorOn = false;
bool progLoaded = false;

#if USE_OLED
U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
#endif

struct StoredProgram { uint32_t magic; PlcProgram p; };
static const uint32_t MAGIC = 0x504C4301;  // "PLC" v1

void writeRelays() {
  for (int i = 0; i < 4; i++) {
    bool on = engine.Q[i];
    digitalWrite(OUT_PIN[i], (RELAY_ACTIVE_LOW ? !on : on) ? HIGH : LOW);
  }
}
void relaysOff() {
  for (int i = 0; i < 4; i++) { engine.Q[i] = 0; }
  writeRelays();
}
bool saveProgram() {
  StoredProgram* s = new StoredProgram; s->magic = MAGIC; s->p = engine.prog;
  prefs.begin("plc", false);
  size_t n = prefs.putBytes("prog", s, sizeof(StoredProgram));
  prefs.end(); delete s;
  return n == sizeof(StoredProgram);
}
bool loadProgram() {
  StoredProgram* s = new StoredProgram;
  prefs.begin("plc", true);
  size_t n = prefs.getBytes("prog", s, sizeof(StoredProgram));
  prefs.end();
  bool ok = (n == sizeof(StoredProgram) && s->magic == MAGIC && s->p.nrungs <= PLC_MAX_RUNGS);
  if (ok) engine.prog = s->p;
  delete s;
  return ok;
}

// Scan task runs on core 0 so serial traffic and the display never disturb timing.
void scanTask(void*) {
  uint32_t last = millis();
  for (;;) {
    uint32_t now = millis(), dt = now - last; last = now;
    if (dt > 200) dt = 200;
    if (plcRun) {
      for (int i = 0; i < 4; i++) {
        int v = digitalRead(IN_PIN[i]);
        engine.I[i] = (INPUT_ACTIVE_LOW ? !v : v) ? 1 : 0;
      }
      engine.step(dt);
      writeRelays();
    }
    vTaskDelay(pdMS_TO_TICKS(SCAN_MS));
  }
}

void sendMonitor() {
  uint32_t i = 0, q = 0, m = 0, t = 0, rs = 0;
  for (int k = 0; k < 4; k++) { i |= engine.I[k] << k; q |= engine.Q[k] << k; }
  for (int k = 0; k < 16; k++) m |= (uint32_t)engine.M[k] << k;
  for (int k = 0; k < PLC_NT; k++) t |= engine.Td[k] << k;
  for (int k = 0; k < 8; k++) rs |= engine.RS[k] << k;
  char b[160];
  int n = snprintf(b, sizeof b, "S %d %x %x %x %x %d,%d,%d,%d ", plcRun ? 1 : 0, (unsigned)i, (unsigned)q, (unsigned)m, (unsigned)t,
                   engine.Cnt[0], engine.Cnt[1], engine.Cnt[2], engine.Cnt[3]);
  for (int k = 0; k < PLC_NT; k++) n += snprintf(b + n, sizeof b - n, "%lu%s", (unsigned long)engine.Tacc[k], k < PLC_NT - 1 ? "," : "");
  n += snprintf(b + n, sizeof b - n, " %x", (unsigned)rs);
  Serial.println(b);
}

#if USE_OLED
void drawOled() {
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x12_tf);
  oled.drawStr(0, 11, "ESP32 PLC");
  oled.drawStr(78, 11, plcRun ? "RUN" : (progLoaded ? "STOP" : "NO PROG"));
  oled.drawHLine(0, 14, 128);
  oled.drawStr(0, 30, "IN");
  oled.drawStr(0, 50, "OUT");
  for (int i = 0; i < 4; i++) {
    int x = 34 + i * 24;
    char l[3] = {(char)('1' + i), 0, 0};
    oled.drawStr(x + 6, 24, l);
    if (engine.I[i]) oled.drawBox(x, 27, 18, 8); else oled.drawFrame(x, 27, 18, 8);
    oled.drawStr(x + 6, 44, l);
    if (engine.Q[i]) oled.drawBox(x, 47, 18, 8); else oled.drawFrame(x, 47, 18, 8);
  }
  char b[24]; snprintf(b, sizeof b, "%d rungs", engine.prog.nrungs);
  oled.drawStr(0, 63, b);
  oled.sendBuffer();
}
#endif

void setup() {
  // Relays first, so they stay off while the rest starts up
  for (int i = 0; i < 4; i++) { digitalWrite(OUT_PIN[i], RELAY_ACTIVE_LOW ? HIGH : LOW); pinMode(OUT_PIN[i], OUTPUT); }
  for (int i = 0; i < 4; i++) pinMode(IN_PIN[i], INPUT);   // GPIO34-39 have no internal pull-ups
  Serial.setRxBufferSize(1024);
  Serial.begin(115200);
#if USE_OLED
  Wire.begin(21, 22); Wire.setClock(400000);
  oled.begin();
#endif
  progLoaded = loadProgram();
  plcRun = progLoaded;
  xTaskCreatePinnedToCore(scanTask, "plc", 4096, NULL, 2, NULL, 0);
}

static char rx[220]; static size_t rxn = 0;
uint32_t lastMon = 0, lastOled = 0;

void handleLine() {
  rx[rxn] = 0; rxn = 0;
  char resp[80];
  plcLink.handle(rx, resp, plcRun ? 1 : 0, engine.prog.nrungs);
  if (plcLink.reqBegin) { plcRun = false; delay(3 * SCAN_MS); relaysOff(); }
  if (plcLink.reqCommit) {
    plcRun = false; delay(3 * SCAN_MS);
    engine.prog = plcLink.stage; engine.reset(); relaysOff();
    if (saveProgram()) { progLoaded = true; plcRun = true; }
    else strcpy(resp, "-flash write failed");
  }
  if (plcLink.reqStop) { plcRun = false; delay(3 * SCAN_MS); relaysOff(); }
  if (plcLink.reqRun && progLoaded) { engine.reset(); relaysOff(); plcRun = true; }
  if (plcLink.reqClear) { plcRun = false; delay(3 * SCAN_MS); engine.prog.clear(); engine.reset(); relaysOff(); prefs.begin("plc", false); prefs.clear(); prefs.end(); progLoaded = false; }
  if (plcLink.monitor >= 0) monitorOn = plcLink.monitor == 1;
  if (resp[0]) Serial.println(resp);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { if (rxn) handleLine(); }
    else if (c != '\r') { if (rxn < sizeof(rx) - 1) rx[rxn++] = c; else rxn = 0; }
  }
  uint32_t now = millis();
  if (monitorOn && now - lastMon >= 100) { lastMon = now; sendMonitor(); }
#if USE_OLED
  if (now - lastOled >= 250) { lastOled = now; drawOled(); }
#endif
}
