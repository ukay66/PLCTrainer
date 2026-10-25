# ESP32 PLC Ladder Editor

A ladder-diagram editor that runs in the browser, plus firmware that turns the ESP32 trainer into a small PLC.

There are two parts, and you set them up differently:

| Part | What it is | How often you touch it |
|---|---|---|
| **Firmware** (`firmware/esp32_plc/`) | The PLC "operating system" on the ESP32. Reads inputs, drives relays and the OLED, runs the stored ladder program. | Upload **once** with the Arduino IDE |
| **Web app** (`index.html`, `app.js`, ...) | Where students draw, simulate, save and open ladder programs, and send them to the ESP32. | Every lesson, nothing to install |

## 1. Put the firmware on the ESP32 (once)

1. Install the Arduino IDE 2.x. In **Boards Manager** install **esp32 by Espressif Systems**.
2. In **Library Manager** install **U8g2** (by oliver).
3. Open `firmware/esp32_plc/esp32_plc.ino`. The other file in that folder, `plc_engine.h`, opens beside it.
4. Choose **Tools → Board → ESP32 Dev Module**, and pick the COM port.
5. Click **Upload**. If it hangs on "Connecting…", hold the **BOOT** button on the ESP32 until it starts.
6. The OLED shows `ESP32 PLC` and `NO PROG`. That is correct before the first transfer.

Settings at the top of the sketch:

* `INPUT_ACTIVE_LOW 1`. The NOYITO module output goes LOW when 24 V is applied. If the input lamps in the app are lit when the toggle is OFF, change it to `0` and upload again.
* `RELAY_ACTIVE_LOW 1`. Correct for relay modules with JD-VCC (input pulls LOW to switch the relay on).
* `USE_OLED 0` if no display is fitted.

| Function | GPIO |
|---|---|
| I1, I2, I3, I4 | 34, 35, 36, 39 |
| Q1, Q2, Q3, Q4 (relays) | 25, 26, 27, 33 |
| OLED SDA, SCL | 21, 22 |

## 2. Publish the web app on GitHub Pages

1. Create a new public repository on GitHub (for example `plc-ladder`).
2. Upload `index.html`, `app.js`, `engine.js`, `examples.js`, `style.css` and `.nojekyll`. Add `firmware/` and this README too, so students can download the firmware.
3. In the repository go to **Settings → Pages**. Under **Build and deployment** choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
4. After a minute the app is at `https://<your-user>.github.io/plc-ladder/`.

Web Serial needs **Chrome or Edge on a computer**, and https (GitHub Pages is https). It does not work in Firefox, Safari or on phones.

## 3. Using the editor

1. Plug the ESP32 into the computer with the USB cable. Close the Arduino Serial Monitor, because only one program can use the port.
2. Open the app. **Connect**, choose the ESP32 port, and wait for "ESP32 connected".
3. Draw the program. Click a cell, then click an element in the palette (or press its key).
4. **Simulate** to test it in the browser. Click I1 to I4 in the bar to flip the inputs. Green lines show power flow.
5. **Transfer** sends the program to the ESP32. It is saved in flash and runs straight away. It also starts automatically after a power cycle.
6. **Monitor** shows live power flow from the real ESP32 while the trainer runs.
7. **Save** downloads a `.plc.json` file. **Open** loads one. The app also keeps an automatic copy in the browser.

### Elements

| Element | Meaning |
|---|---|
| NO, NC | Normally open and normally closed contact. Address can be I (input), Q (relay), M (marker), T (timer done), C (counter reached preset) |
| Rising P, Falling N | On for one scan when the address goes from 0 to 1, or from 1 to 0 |
| Coil | Writes the rung result to Q or M |
| Coil NOT | Writes the opposite of the rung result |
| Set, Reset (RS latch) | Set turns Q or M on and it stays on. Reset turns it off. Reset is better placed in a later rung so it wins |
| TON | On-delay timer. T done after the rung has been on for the delay. Drops when the rung drops |
| TOF | Off-delay timer. T is on while the rung is on and stays on for the delay after it drops |
| CTU, CTD | Count up and count down on each rising edge of the rung |
| CRES | Resets the counter to 0 while the rung is on |

Counter C is "done" when the count is at or above the preset. Count range is 0 to 9999. Timer delay is in the Selected panel (ms, s or min).

### Layout rules

* A rung has 8 columns for contacts and **column 9 for outputs**. Coils and blocks always land in column 9 of the chosen row.
* An empty cell in the top row is a plain wire. In lower rows, empty means open.
* **Parallel (OR) branch:** select a contact, click **Branch ↓**. This adds a wire below and joins both rows. Place the second contact in the lower cell. To branch around several contacts, fill the lower row with contacts or wires, then click the small dots between the rows to add or remove vertical joins.
* Up to 4 rows, 40 rungs, 8 timers (T1-T8), 4 counters (C1-C4), 16 markers (M1-M16).
* The ESP32 scans every 10 ms. Rungs run top to bottom, and a coil's new value is seen by the rungs below it in the same scan.

Keys: arrows move, 1 NO, 2 NC, 3 P, 4 N, 5 Coil, 6 Coil NOT, 7 Set, 8 Reset, t TON, f TOF, u CTU, d CTD, r CRES, w Wire, b Branch, Delete clear, Ctrl+Z / Ctrl+Y undo / redo, Ctrl+S save.

## Troubleshooting

* **"Port is open but the ESP32 did not answer"**: the firmware is not uploaded, or another program holds the port. Reconnect after closing the Serial Monitor.
* **The port does not appear**: install the USB driver for the board's chip (CP210x or CH340).
* **An input looks inverted**: toggle `INPUT_ACTIVE_LOW` as described above.
* **A relay is on when it should be off**: check `RELAY_ACTIVE_LOW` and that the module's VCC-JD-VCC jumper is removed.
* **Transfer says "checksum mismatch"**: send again. Use a short, good USB cable.

## Technical notes

* Transfer uses plain text over USB serial at 115200 baud: `BEGIN`, then `T`/`K` preset lines, one `R` line per rung (76 bytes in hex), then `END <count> <FNV-1a hash>`. The ESP32 accepts the program only if the count and hash match. Other commands: `PING`, `RUN`, `STOP`, `MON 0/1`, `CLR`.
* The scan logic exists twice, in `engine.js` (simulator) and in `plc_engine.h` (ESP32). They were tested against each other with 300 random programs, and they agree.
* Run `node test/semantic.js` to check the examples.
