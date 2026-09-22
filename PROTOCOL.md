# KTMicro KT USB Protocol — Complete Reference

Reverse-engineered from `KT_USB_APP.exe` (1.0.17), `KT_BOOT_TOOL_1.0.58.exe`
(static Qt PE32 binaries, disassembled), the 20 vendor hex logs shipped inside
`writechip/`, and cross-checked against the upstream `ktmicro-tools` repo
(community-verified on KT02H20 hardware). Covers:

1. [Run mode — register protocol](#1-run-mode--register-protocol)
2. [Run mode — complete register map](#2-register-map)
3. [Boot mode — bootloader / flash protocol](#3-boot-mode--bootloader-protocol)
4. [Firmware image layout](#4-firmware-image-layout)
5. [Persistence flows](#5-persistence-flows)
6. [Vendor binary internals](#6-vendor-binary-internals)
7. [Open questions](#7-open-questions)

---

## 1. Run mode — register protocol

**Device** (run mode):

| Chip | VID:PID | Notes |
|------|---------|-------|
| KT0231H | `0x31B2:0x1132` | 6-band DAC + 6-band ADC EQ banks |
| KT0211L | `0x31B2:0x0111` | product `"CDS.KT USB Audio"`, FW `CDSV100.003` |
| KT02H20 | `0x31B2:0x0111` | same PID as KT0211L — tell apart by product string |

Composite device: USB Audio class + HID interface (HID interface 3 per
upstream). **All DSP access is via 11-byte HID reports led by report ID
`0x4B`.** The vendor apps talk to the HID device with raw
`CreateFileA`/`WriteFile`/`ReadFile` (no `HidD_*` on the I/O path; `hid.dll`
is loaded for enumeration strings only). The bootloader tool also loads
`HidD_SetFeature`/`GetFeature` — boot mode uses feature reports.

### Read register — `0x52` ('R')

```
TX: 4B  [addr LE32]  52 00 00 00 00 00
RX: 4B  [addr LE32]  52 00 [value LE32]
```

### Write register — `0x57` ('W')

```
TX: 4B  [addr LE32]  57 00 [value LE32]
RX: 4B  [addr LE32]  57 00 [status LE32]
```

Write status differs **per chip**:

| Chip | Write ACK | Verified |
|------|-----------|----------|
| KT02H20 / KT0211L | `0x03` | upstream + live (0211L) |
| KT0231H | `0x4F` | live hardware (2026-09-21) |

### SAVE to flash — `0x53` ('S')

```
TX: 4B 00 00 00 00  53 00 00 00 00 00
RX: status byte (payload[6]) = 0x03 or 0x4F
```

Recovered from `KT_USB_APP.exe` 1.0.17 (function @ `0x546900`, caller
@ `0xca3eda` → user-facing toast): commits the live DSP RAM state to flash;
the device typically reboots. The vendor binary accepts **exactly**
`0x03` (KT02H20-era) or `0x4F` (newer firmware) as success — mirrored in
our app's `saveToFlash()`. Same Tanchjim-side feature is
`saveRegData2Flash` ("will reboot device"). Full run-mode inventory of the
vendor binary (all `WriteFile` packet-TX call sites): commands are exactly
`{0x43, 0x52, 0x53, 0x57}` — no hidden 4th command. Gated to
KT0211L/KT02H20 (`0x0111`) in our UI; never sent to KT0231H (unverified
there).

### Memory word read — `0x08` (READ-ONLY)

```
TX: 4B [addr LE32]  08 00 00 00 00 00
RX: word at payload[0..3] (NOT payload[6..9] like register reads)
```

From the decompiled vendor Android app (`FUN_0054d170`: loops `count`
times, `addr += 4`; single-shot variant `FUN_0054d340`). ISP set is
`0x33/0x32/0x08/0x21/0x88`. On JA11/KT02H20 the runtime has no `0x08` case
so it answers zeros and `0x33` times out; KT0211L/KT0231H untested.
Implemented in-app as `memRead32()` + Peek memory button (pure reads).

### No software flash dump — definitive (community-verified)

Independent RE (ParkWardRR: decompiled Android bootloader client +
FiiO web-app JS, 2026-09) converges with ours: the CDC bootloader has 10
tokens and **no read/dump/upload token**; `INF` (`f0 49 4e 46`) returns only
the whole-image (size, CRC-32) fingerprint on the flag=1 path; run-mode
`0x08` reads unmapped space, not flash. A true backup needs hardware
(SWD/SPI). Keep the factory image before flashing — it can't be
recovered off-device. Boot entry (for reference, NOT sent by our app):
HID output report `0x54` + `"12345678\0"` (Ircama) / `"T12345678"`
(ParkWardRR) → re-enumerates as `8888:cdc0` CDC serial, 9600 8N1, then
`KTM/CHP/CFG/PWO/KSTA/0x69-blocks/STP/ZRST` (`5a 52 53 54`).

### Handshake — `0x43` ('C')

```
TX: 4B 00 00 00 00  43 00 00 00 00 00
RX: bytes 7..10 = 0x03 or 0x4F
```

⚠ **Do not send this on KT0231H** — it stalls the HID pipe on that chip
(reproduced 2026-09-21). Reads/writes work without it. The vendor app sends it
on connect; our app deliberately does not.

---

## 2. Register map

### Identity

| Addr | Content |
|------|---------|
| 0x00–0x07 | version string, LE32 ASCII chunks (e.g. `"1.0.17"`; KT0231H: @ 0x06) |
| 0x01 | protocol/model flags — **bit9 (0x0200) = single-DAC model** |
| 0x08–0x0D | build date string |
| 0x40–0x47 | USB manufacturer string (writable) |
| 0x48–0x4F | USB product string (writable) |
| 0x50–0x56 | USB serial string (writable) |
| 0x5B | `[PID:16][VID:16]` packed (writable) |
| 0xE1 | magic `0x12345678` (device-side) |

### Volume — vendor-confirmed semantics (KT0211L / KT02H20)

| Addr | Meaning |
|------|---------|
| 0x3A | **A_ADC analog PGA** — index into `{0, −6, 8, 14, 20, 26, 32, 44 dB}` |
| 0x3B | **A_DAC analog PGA** — 0 = mute, index 1..15 → `1.5·(i−1) − 18` dB (−18 … +3 dB) |
| 0x65 | **DIG_ADC** digital gain — byte0 signed, units 0.5 dB |
| 0x66 | **DIG_DAC** — byte0 = DACL (single-DAC models: the only DAC gain); stereo models byte0 = DACL, byte1 = DACR |

> ⚠ On **KT0231H** addresses 0x3A/0x3B are **EQ band registers** (not PGA),
> and 0x65/0x66 read `0x00000000` — the volume block lives elsewhere on that
> die and is still unidentified. The app treats volume as best-effort per
> profile.

### EQ filters

Encoding identical on all three chips; only the base addresses differ.

```
A_reg (32-bit) = [freq_Hz:16][gain×10:16 signed]
B_reg (32-bit) = [type:3][rsv:13][Q×1000:16]     types: 0 Peak 1 LPF 2 HPF 3 LowShelf 4 HighShelf
```

| Chip | ADC enable | ADC bands | DAC enable | DAC bands |
|------|-----------|-----------|------------|-----------|
| KT02H20 / KT0211L | 0x18 (bit0) | 0x1A–0x23 (5 bands) | 0x24 (bit0) | 0x26–0x2F (5 bands) |
| KT0231H | **0x41** (bit0) | **0x42–0x4D (6 bands)** | **0x34** (bit0) | **0x35–0x40 (6 bands)** |

KT0231H factory defaults: 61/122/184/248/316/392 Hz, 0 dB, Peak, Q 0.700.
KT0211L EQ-enable registers read `3`, not `1` — bit1 meaning unknown; the app
sets/clears bit0 only and preserves the rest.

### DRC (vendor app only; upstream-verified on KT02H20)

```
0x71 NoiseGate: [EN(bit7)+flags 0x3C][THhigh = 256+dB][THlow = 256+dB][GateVol = 256+dB] …
0x72: [AT_ms:16][RT_ms:16]      0x73: [hold 0x000A][noiseT_ms:16]
0x78 Limiter:  [EN(bit7)+SOFT(bit6)][rsv][threshold = 256+dB] …   0x79: [AT][RT]
```

Only NoiseGate (0x71–0x73) and Limiter (0x78–0x79) are wired in the vendor
app; the Compander/Expander/AGC pages are UI stubs.

---

## 3. Boot mode — bootloader protocol

Bootloader device: **`0x31B2:0x0101`** (upstream-verified; vendor descriptor
templates in KT_BOOT_TOOL also embed PIDs `0x0001`/`0x0002`, strings
"KTMicro" / "KT-USB-Audio"). Enter boot mode per dongle (button/short).

**Transport: HID feature reports** — `SetReport`/`GetReport`, report ID `0x00`
prepended by the host, payload = everything below. Responses come back as
feature/input reports; ACK is at payload[0] (after report ID byte).

### Commands (4-byte little-endian u32 frames)

| u32 LE | Bytes | Name | Response |
|--------|-------|------|----------|
| 0x1E4B544D | `1E 4B 54 4D` | **KTM** sync/handshake | `78` (repeat until ACK) |
| 0xF0564552 | `F0 56 45 52` | **VER** version | `78 <b0> <b1>` |
| 0xF04B4559 | `F0 4B 45 59` | **KEY** unlock | `78 00 78` |
| 0xD2434850 | `D2 43 48 50` | **CHP** chip ID | `[id0 id1 id2][name ASCII 8][sum8]` |
| 0x2D… | 10 bytes | **CFG** flash config | `78` |
| 0x3C50574F | `3C 50 57 4F` | **PWO** power-on flash | `78 78` |
| 0x4B535441 | `4B 53 54 41` | **KSTA** start | `78` |
| 0x96535450 | `96 53 54 50` | **STP** stop/finish | — |
| 0x69… | variable | **write block** | `78` then `A5` |

The 3 ASCII command names are stored as 4-byte constants in KT_BOOT_TOOL's
`.rdata` (e.g. `0x15BA060: 69 52 41 4D / F0 4B 45 59 / F0 56 45 52` = **RAM**,
**KEY**, **VER**; `0x1378D20: 2D 43 49 44 / D2 43 48 50` = **CID**, **CHP**).
`0x69 52 41 4D` ("RAM") is the command that loads `ram_flashload.bin` into RAM
on chips whose ROM lacks the flash routines.

**CHP response checksum** — verified on all three captured responses:
`last byte = sum8(every preceding byte)`. e.g. `12 40 85 B2 "0211LC02" 3E`
(0x12+0x40+0x85+0xB2+0x30+0x32+0x31+0x31+0x4C+0x43+0x30+0x32 = 0x3E ✓).
Captured IDs: `0211LC02` (KT0211L), `0210B02`, `KT02H20B`.

**CFG payload** (matches vendor log byte-for-byte):

```
2D 29 00 [chipType] [sectorSize] [timing] [flashBase LE16] 00 BC
2D 29 00   10          0E            15         60 00          00 BC
```

### Write block (0x69)

```
[0x69][subtype u8][region u16 LE][addr u16 LE][data …]
```

- data = 512 B per block (upstream, hardware-verified). The vendor v1.0.58
  tool sends 1024 B **plus a 4-byte tail** (see §7).
- `addr` = block counter: starts **0x80**, `+4` per block.
- `subtype`: 0x00 data · 0xF0 meta/header · 0x90 config block · 0x10 signature.
- `region`: 0x00E4 app body · 0x1023 meta (vendor) · 0x00E2 config ·
  0x00E0 signature · 0x0024 code region (seen in vendor log).

### Full flash sequence (upstream + vendor log agree)

```
KTM (retry until 0x78) → VER → KEY → CHP → CFG → PWO → KSTA
  → writeBlock(0x80, meta512,     sub 0xF0)           # meta = chipId+Size+ver+date+ENTY
  → addr = 0x84; for each 512B chunk: writeBlock(addr++, chunk, sub 0x00)
  → writeBlock(addr, zeros512,    sub 0x90, region 0xE2)
  → writeBlock(0x80, sig512,      sub 0x10, region 0xE0)
  → STP
```

Every data-block write is ACKed with `78` followed by `A5` (accept/continue).

**Meta block layout** (as observed in the vendor log for a KT0211L):

```
"0211LC02"                         chip ID
"Size" + u32 LE  0x0000A690        total payload bytes (42 640)
"66" + "015275"                    build number
"2021-10-22"                       build date
"ENTY" + u32 LE ×2  0x0008B000     entry point(s)
… zero padding to 512/1008 B
```

The vendor's session totals: 1 meta (1008 B) + 40 data (1024 B each) +
1 config (656 B) + 1 signature (16 B) = **42 640 = exactly the "Size" field**.

### Signature block

`"KT_lnv1b_flash_1"` + CRC32 (zlib, reflected 0xEDB88320, init/xorout
0xFFFFFFFF) of the firmware body. Flash-name selection per chip family
(disassembled from KT_BOOT_TOOL):

| chip | flash name |
|------|-----------|
| KT02H2x / 0211L | `KT_lnv1b_flash_1` |
| MSV2B family | `KT_msv2b_flash_1` |
| KT0712 | `KTM_TT_V3_flash_1` |
| other | `KT_lnv1b_flash_1` |

CRC8 table (poly 0x1D, init 0, `crc = tbl[crc ^ b]`, no xorout) exists at
`.rdata 0x1667CA0` and is used to validate received frames
(`crc8(buf+4, 0x3C)` over 60-byte blocks in the read path) and for logging.

---

## 4. Firmware image layout

Derived from the `JA11_V2.2` vs `JA11_V2.2_Ellyn` BIN diff plus the boot-log
reconstruction (a full 42 640-byte vendor image for a KT0211L was extracted
from `Log/23-10-11 18-05-56log.txt` and is reproducible with
`scripts/reconstruct_fw.py`).

- EQ table entries (persisted, 8 bytes each, LE):
  `[freq_Hz u16][Q×1000 u16][gain×10 s16][type u16]`
- JA11-class image: DAC EQ table @ **0x106A**, ADC EQ table @ **0x109A**
  (5 bands each).
- Second source: Tanchjim `KT0211L_TANCHJIM-DSP_20240815_1.0.2.bin`
  (42 272 B, sha256 `A8DC36CC…EB57094`) confirms the same offsets and entry
  layout with factory 1000/2000/5000/8000/10000 Hz, Q 0.707, 0 dB, Peak.
  Bank-enable byte @ **0x10E8** (= adcOff+0x4E) reads **0x03** (bit0=DAC,
  bit1=ADC — matches live KT0211L EN regs; the JA11 Ellyn preset moves this
  same byte 0x04→0x07). USB device descriptor @ ~**0xA0F8** (VID `0x31B2`,
  PID `0x0111`), product ASCII @ **0x1120**, flash tag
  `KT_lnv1b_flash_10211LC02…`, build stamp `Aug 15 2024`. No UTF-16 strings
  in the image (USB strings are built at runtime from ASCII).
- The extracted vendor image stores section markers such as `REG:` (factory
  register defaults block) inside the app body; tables are best **located by
  pattern**, not hardcoded offsets — that is what the app's BIN patcher does
  and it refuses to patch when the pattern is absent.

---

## 5. Persistence flows

**There is no run-mode "save" command.** Static disassembly of
`KT_USB_APP.exe` (HID layer = WriteFile/ReadFile only, no feature-report
write on the DSP path) and the vendor docs agree: persisted EQ = patched
firmware image + bootloader reflash.

1. **Vendor flow**: obtain the unit's own BIN → patch EQ tables →
   `KT_BOOT_TOOL` → *Load File* → *Burn* (chips list includes KT0211L and
   KT0231H; config keys `BinPath/ChipType/ChipNum/Interface/Baund/Filter/
   CompareChip/Erase/DevconEn/DevconVID` in `ktRES/info.ini`).
   The USB app's own "Save" produces `KT_0211L_02H20_*.bin` + `*_new.bin`
   (strings at 0x125799B/0x12579FF) — same flow.
2. **This app**: *Firmware Persistence (BIN patch)* card = load → patch →
   export `_new.bin`; *Boot Mode Flasher* card = reflash via WebHID
   (§3), using the upstream 512 B no-tail block format.

⚠ Never flash a foreign BIN (e.g. a JA11 image onto a KT0211L unit) — a
persist-flash must patch the unit's **own** firmware backup.

---

## 6. Vendor binary internals

Both EXEs: statically-linked Qt (`.qtmetad` section), i386 PE, stripped
external PDB, ~22–23 MB.

**KT_BOOT_TOOL_1.0.58** — Qt widgets: `comboBox_ChipType/ChipNum/Interface/
List`, `comboBox_baund` (115200/256000/576000/921600 — UART interface),
`checkBox_erase_all/compareChip/devcon/ktspi_test`, `pushButton_burn/erase/
restore/query_ver`, `plainTextEdit` log, `spinBox_sucess/Fail`,
`lineEdit_SIZE/CRC/ChipNum/soft_ver/Path`. Functions (via debug strings):
`ShakeHand, ComRead, CheckFlashCodeAck, CheckRamCodeAck, erase, flash_write,
flash_erase, flash_confirm, flash_write_crc, flash_cancel, flash_read_crc
(crc8+crc32), flash_read_all, chip_rst, crc8`. Qt resources: `ram_flashload.bin`,
`ram_getcid.bin`, `KT0712_reset_spi.bin`, `devcon_32/64.exe`, `devcon.bat`,
`doc.pdf`, `KT_VCP_V1.0.0_Setup.exe`, `tubiao.png`. Update check pings
`http://101.42.35.97/KT_WORK/KT_BOOT_TOOL/KT_BOOT_TOOL.xml`. Device filter
skips `kbd / Rapoo / USB Receiver / keyboard / OrayV` entries.

**KT_USB_APP 1.0.17** — tabs `toolButton_VOLUME / EQ / REG`; EqModule with
**15 band groups** (`pushButtonEN/P/LP/HP/LS/HS_N`, `Slider_Gain_N`,
`spinBox_gain/FRQ/QV_N` 0–14), `comboBox_TYPE`, `ADC/DAC/ALL_EN/RESET/PASS`;
VOLUME page `groupBox_PGA` (`comboBox_A_DAC/A_ADC`) + `groupBox_Digital`
(DACL/DACR/DIG_ADC); REG page = 6 raw read/write groups; DrcModule
(Noisegate/Limiter/Agc/Expander/Compressor — last three are stubs); BIN save
(`KT_0211L_02H20_*.bin` / `*_new.bin`); uses QCustomPlot for curves.

**Why the vendor app couldn't see the test dongle**: its HID enumerator
filters by usage/keyboard/mouse heuristics (`HIDClass/Mouse/Keyboard`,
`&mi_`, skip-list above) — our WebHID access to the same device works fine.

**`kt_usb_cmd_tool.exe` v1.3.16** (carved from `TANCHJIM_DSPS_BOOT_TOOL_1.0.03.exe`
offset 21872, 5.86 MB MinGW static-Qt CLI; runs standalone, `-h` verified):
`arg1 -m(KT020X) -s(KT021X KT02H2X KT02F2X)` — HID vs serial transport;
`arg2 -b(boot) -pb(boot by path) -v(ver) -pl(path list) -t(cdc) -bv(boot ver)`
(plus hidden `-fb`/`-nb`); `arg3/4 vid pid`, `arg5 xxx.bin`. Examples use
`0x31b2 0x0020` (KT020X boot PID) and HID path `vid_352f&pid_0100&mi_03`
(boot-mode PID on that family). Opens HID via raw `\\?\hid#…` CreateFile
(imports are system-only; `HidD_*` resolved at runtime). Log format
`/Log/log.txt`, `STEP_ShakeHand`, `turn to cdc`, default boot image
`KT0206_boot_v1.05_20210608.bin`, flash tag `KT_msv2b_flash`.
**There is deliberately no dump/read flag** — `-v` prints the app soft
version, `-t` only reboots into CDC boot mode. `-m -pl 0x31b2` (pure
SetupAPI enumeration, no device I/O) lists the test dongle as
`vid_31b2&pid_0111&mi_03`. Combined with the decompiled-bootloader verdict
(§7.7), the vendor toolset has no firmware-read primitive at all.

---

## 7. Open questions

1. **0x69 block tail (vendor v1.0.58).** The vendor appends 4 bytes per
   1024-B block; identical zero-blocks produce different tails, so the input
   covers the block header/sequence. Not zlib-CRC32 over any visible window,
   not sum/fletcher/adler/CRC32C, not a running CRC. Upstream (hardware-
   tested) sends **no tail at 512 B**, and this app follows upstream. The 43
   captured vendor tails are preserved in `scripts/crack_checksum.py` output
   for future comparison. Bootloader ROM code (`ram_flashload.bin`, still
   packed inside the Qt resource blob) would settle this.
2. **KT0231H volume registers.** 0x3A/0x3B are EQ regs here; 0x65/0x66 read 0.
3. **KT0211L EQ-enable bit1.** Enable regs read 3; app preserves bits.
4. **Erase command.** `Erase=1` in `ktRES/info.ini` and `pushButton_erase`
   exist; the opcode was not exercised in any captured log.
5. **`0x43` handshake** — sent by the vendor app, stalls KT0231H; omitted.
6. **Boot PID** — upstream uses 0x0101; vendor descriptor templates also
   contain 0x0001/0x0002. The app's boot panel tries all three.
7. **Firmware dump (CLOSED — proven absent, not merely uncaptured).**
   Three independent lines of evidence: (a) `kt_usb_cmd_tool` v1.3.16's full
   CLI has burn/verify-query/list/cdc/boot-ver and no dump op; (b) the
   decompiled CDC bootloader exposes 10 tokens with no flash read
   (ParkWardRR/ja11-config-toolkit, 2026-09-05: INF returns size+CRC32 only);
   (c) every captured vendor log is write-direction. Run-mode `0x08` reads
   unmapped space. Software backup of this family is impossible — true
   backup needs hardware (SWD/SPI clip). Do not ship a dump button on the
   vendor protocol; the honest UI is the 0x08 memory peeker + register dump.
