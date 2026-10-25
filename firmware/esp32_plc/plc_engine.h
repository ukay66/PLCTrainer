// Ladder scan engine and transfer-protocol handler.
// Plain C++ (no Arduino calls) so it can be unit-tested on a PC.
// Must behave exactly like engine.js in the web app.
#pragma once
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

#define PLC_ROWS 4
#define PLC_COLS 8
#define PLC_NCOL 9
#define PLC_CELLS 36
#define PLC_RB 76
#define PLC_MAX_RUNGS 40
#define PLC_NT 8
#define PLC_NC 4

struct PlcProgram {
  uint8_t  nrungs;
  uint32_t tpre[PLC_NT];
  uint16_t cpre[PLC_NC];
  uint8_t  rungs[PLC_MAX_RUNGS][PLC_RB];
  void clear() { memset(this, 0, sizeof(*this)); }
};

class PlcEngine {
public:
  PlcProgram prog;
  uint8_t  I[4], Q[4], M[16], Td[PLC_NT];
  uint32_t Tacc[PLC_NT];
  int16_t  Cnt[PLC_NC];
  uint8_t  prev[PLC_MAX_RUNGS * PLC_CELLS];

  PlcEngine() { prog.clear(); reset(); }

  void reset() {
    memset(I, 0, sizeof I); memset(Q, 0, sizeof Q); memset(M, 0, sizeof M);
    memset(Td, 0, sizeof Td); memset(Tacc, 0, sizeof Tacc); memset(Cnt, 0, sizeof Cnt);
    memset(prev, 0, sizeof prev);
  }

  uint8_t bit(uint8_t a) const {
    uint8_t k = a >> 5, i = a & 31;
    switch (k) {
      case 0: return i < 4 ? I[i] : 0;
      case 1: return i < 4 ? Q[i] : 0;
      case 2: return i < 16 ? M[i] : 0;
      case 3: return i < PLC_NT ? Td[i] : 0;
      case 4: return i < PLC_NC ? (Cnt[i] >= (int32_t)prog.cpre[i] ? 1 : 0) : 0;
    }
    return 0;
  }
  void setBit(uint8_t a, uint8_t v) {
    uint8_t k = a >> 5, i = a & 31;
    v = v ? 1 : 0;
    if (k == 1 && i < 4) Q[i] = v;
    else if (k == 2 && i < 16) M[i] = v;
  }

  void step(uint32_t dt) {
    for (uint8_t r = 0; r < prog.nrungs; r++) evalRung(r, dt);
  }

  void evalRung(uint8_t ri, uint32_t dt) {
    const uint8_t* b = prog.rungs[ri];
    uint8_t* pv = prev + (uint16_t)ri * PLC_CELLS;
    uint32_t lk = (uint32_t)b[72] | ((uint32_t)b[73] << 8) | ((uint32_t)b[74] << 16) | ((uint32_t)b[75] << 24);
    uint8_t p[PLC_ROWS] = {1, 1, 1, 1};
    for (uint8_t n = 0; n < PLC_NCOL; n++) {
      uint8_t r = 0;
      while (r < PLC_ROWS) {
        uint8_t e = r;
        while (e < PLC_ROWS - 1 && ((lk >> (e * 9 + n)) & 1)) e++;
        if (e > r) {
          uint8_t v = 0;
          for (uint8_t k = r; k <= e; k++) v |= p[k];
          for (uint8_t k = r; k <= e; k++) p[k] = v;
        }
        r = e + 1;
      }
      if (n < PLC_COLS) {
        for (uint8_t r2 = 0; r2 < PLC_ROWS; r2++) {
          uint8_t ci = r2 * PLC_NCOL + n, t = b[2 * ci], op = b[2 * ci + 1], pin = p[r2], out = 0;
          switch (t) {
            case 0: out = (r2 == 0) ? pin : 0; break;
            case 1: out = pin; break;
            case 2: out = pin & bit(op); break;
            case 3: out = pin & (bit(op) ^ 1); break;
            case 4: { uint8_t v = bit(op); out = pin & v & (pv[ci] ^ 1); pv[ci] = v; break; }
            case 5: { uint8_t v = bit(op); out = pin & (v ^ 1) & pv[ci]; pv[ci] = v; break; }
            default: out = 0;
          }
          p[r2] = out;
        }
      } else {
        for (uint8_t r2 = 0; r2 < PLC_ROWS; r2++) {
          uint8_t ci = r2 * PLC_NCOL + n, t = b[2 * ci], op = b[2 * ci + 1], pin = p[r2];
          if (t < 16) continue;
          uint8_t idx = op & 31;
          switch (t) {
            case 16: setBit(op, pin); break;
            case 17: setBit(op, pin ^ 1); break;
            case 18: if (pin) setBit(op, 1); break;
            case 19: if (pin) setBit(op, 0); break;
            case 20:
              if (idx < PLC_NT) {
                if (pin) {
                  uint32_t a = Tacc[idx] + dt; if (a > 0x7fffffffu) a = 0x7fffffffu;
                  Tacc[idx] = a; Td[idx] = (a >= prog.tpre[idx]) ? 1 : 0;
                } else { Tacc[idx] = 0; Td[idx] = 0; }
              }
              break;
            case 21:
              if (idx < PLC_NT) {
                if (pin) { Td[idx] = 1; Tacc[idx] = 0; }
                else if (Td[idx]) {
                  uint32_t a = Tacc[idx] + dt; if (a > 0x7fffffffu) a = 0x7fffffffu;
                  Tacc[idx] = a;
                  if (a >= prog.tpre[idx]) { Td[idx] = 0; Tacc[idx] = 0; }
                }
              }
              break;
            case 22:
              if (idx < PLC_NC) { if (pin && !pv[ci] && Cnt[idx] < 9999) Cnt[idx]++; pv[ci] = pin; }
              break;
            case 23:
              if (idx < PLC_NC) { if (pin && !pv[ci] && Cnt[idx] > 0) Cnt[idx]--; pv[ci] = pin; }
              break;
            case 24:
              if (idx < PLC_NC && pin) Cnt[idx] = 0;
              break;
          }
        }
      }
    }
  }
};

// Line-based transfer protocol. Every command gets one reply line starting with
// '+' (ok) or '-' (error). Program lines are hashed so a corrupt transfer is rejected.
//   PING | BEGIN | T i ms | K i n | R n hex152 | END count hash8 | RUN | STOP | MON 0/1 | CLR
class PlcLink {
public:
  PlcProgram stage;
  uint8_t  gotRungs = 0;
  uint32_t hash = 0x811c9dc5u;
  bool     inTransfer = false;
  // Requests for the host sketch to act on after handle() returns:
  bool reqBegin = false, reqCommit = false, reqRun = false, reqStop = false, reqClear = false;
  int  monitor = -1;   // -1 no change, 0 off, 1 on

  void fnv(const char* s) {
    while (*s) { hash ^= (uint8_t)*s++; hash *= 16777619u; }
  }
  static int hexv(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }

  // 'line' is modified in place? No: it is only read. 'resp' must hold at least 64 bytes.
  void handle(const char* line, char* resp, int running, int nrungsLoaded) {
    reqBegin = reqCommit = reqRun = reqStop = reqClear = false; monitor = -1;
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\r' || line[len - 1] == '\n' || line[len - 1] == ' ')) len--;
    char buf[200];
    if (len == 0) { resp[0] = 0; return; }
    if (len >= sizeof buf) { strcpy(resp, "-line too long"); return; }
    memcpy(buf, line, len); buf[len] = 0;

    if (!strcmp(buf, "PING")) { sprintf(resp, "+PLC 1 %d %d", nrungsLoaded, running ? 1 : 0); return; }
    if (!strcmp(buf, "RUN"))  { reqRun = true;  strcpy(resp, "+run"); return; }
    if (!strcmp(buf, "STOP")) { reqStop = true; strcpy(resp, "+stop"); return; }
    if (!strcmp(buf, "CLR"))  { reqClear = true; strcpy(resp, "+cleared"); return; }
    if (!strcmp(buf, "MON 1")) { monitor = 1; strcpy(resp, "+mon on"); return; }
    if (!strcmp(buf, "MON 0")) { monitor = 0; strcpy(resp, "+mon off"); return; }
    if (!strcmp(buf, "BEGIN")) {
      stage.clear(); gotRungs = 0; hash = 0x811c9dc5u; inTransfer = true; reqBegin = true;
      strcpy(resp, "+begin"); return;
    }
    if (!inTransfer) { strcpy(resp, "-send BEGIN first"); return; }

    if (buf[0] == 'T' && buf[1] == ' ') {
      int i; unsigned long v;
      if (sscanf(buf + 2, "%d %lu", &i, &v) != 2 || i < 0 || i >= PLC_NT) { strcpy(resp, "-bad T"); return; }
      stage.tpre[i] = (uint32_t)v; fnv(buf); strcpy(resp, "+"); return;
    }
    if (buf[0] == 'K' && buf[1] == ' ') {
      int i; unsigned long v;
      if (sscanf(buf + 2, "%d %lu", &i, &v) != 2 || i < 0 || i >= PLC_NC) { strcpy(resp, "-bad K"); return; }
      stage.cpre[i] = (uint16_t)(v > 9999 ? 9999 : v); fnv(buf); strcpy(resp, "+"); return;
    }
    if (buf[0] == 'R' && buf[1] == ' ') {
      char* e = NULL;
      long n = strtol(buf + 2, &e, 10);
      if (!e || *e != ' ' || n < 0 || n >= PLC_MAX_RUNGS) { strcpy(resp, "-bad R index"); return; }
      const char* h = e + 1;
      if (strlen(h) != PLC_RB * 2) { strcpy(resp, "-bad R length"); return; }
      for (int k = 0; k < PLC_RB; k++) {
        int a = hexv(h[2 * k]), c = hexv(h[2 * k + 1]);
        if (a < 0 || c < 0) { strcpy(resp, "-bad hex"); return; }
        stage.rungs[n][k] = (uint8_t)(a * 16 + c);
      }
      if (n + 1 > gotRungs) gotRungs = (uint8_t)(n + 1);
      fnv(buf); strcpy(resp, "+"); return;
    }
    if (!strncmp(buf, "END ", 4)) {
      unsigned cnt; unsigned long hv;
      if (sscanf(buf + 4, "%u %lx", &cnt, &hv) != 2) { strcpy(resp, "-bad END"); return; }
      inTransfer = false;
      if (cnt != gotRungs) { strcpy(resp, "-rung count mismatch"); return; }
      if ((uint32_t)hv != hash) { strcpy(resp, "-checksum mismatch"); return; }
      stage.nrungs = (uint8_t)cnt;
      reqCommit = true;
      sprintf(resp, "+saved %u", cnt);
      return;
    }
    strcpy(resp, "-unknown command");
  }
};
