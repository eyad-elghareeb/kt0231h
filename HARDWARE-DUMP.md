# Hardware Firmware Dump & Recovery Guide

The vendor toolchain provably contains **no software read primitive for the
Helios family's internal flash** (`PROTOCOL.md` §7.7, §9.4) — but the
datasheet gives every pin you need to do it in hardware, and v11's RE pass
found one *partial* software exception (§4 below). This is the honest,
complete map of every way to get your firmware back.

## 1. The memory map you are dumping

| Region | Address | Size | Notes |
|---|---|---|---|
| Header (flasher meta) | `0x00000`–`0x03000` | 12 KB | stripped before load, but *stored* in flash |
| Code + rodata | `0x03000`–(per build) | ~38–60 KB | loads at RAM `0x83000` |
| `REG:` factory defaults | `0x01000` | — | EQ tables @ `0x106A`/`0x109A`, EN @ `0x10E8` |
| Debug log strings | tail | ~4 KB | printf table |
| Total internal flash | `0x80000` (CPU view) | **2 Mbit = 256 KB** | KT02F20 datasheet; images are 17–160 KB |

## 2. SWD — the documented debug port (primary path)

Per the vendor datasheet's GPIO function map (`ARCHITECTURE.md` §3):

| Signal | Pin | Notes |
|---|---|---|
| **SWD_CLK** | GPIO4 (FUNC_SEL=1) | clock |
| **SWD_DAT** | GPIO5 (FUNC_SEL=1) | bidirectional data |
| GND | any ground | — |
| VDD5V | 3.0–5.5 V supply sense | power only if dongle isn't self-powered |

Procedure:

1. **Find the pads.** On QFN-36 4×4 mm parts the GPIO4/5 balls are on the
   bottom side; dongle PCBs sometimes route them to test pads near the
   connector. Trace from the keypad/GPIO side of the PCB if present.
2. **Attach a compatible probe.** The core is Andes AndeStar v3 (NDS32,
   `ARCHITECTURE.md` §1) — use an Andes EDM-compatible adapter or a probe
   with NDS32 SWD support; OpenOCD's NDS32 target files are the open option
   (check your build for `nds32v3`/`andes` target cfg). Generic CMSIS-DAP
   probes speak the wire protocol but need NDS32-aware host software.
3. **Dump** the full 256 KB flash window (CPU base `0x80000`) plus RAM if
   you want the runtime state. Reconstruct the flasher-format image with
   the meta header (`scripts/kt_img_header.py` documents the field order)
   so the dump stays flashable by KT_BOOT_TOOL.
4. **Verify** with the header checks: chip-id string, `Size` field vs
   payload, CRC-32 (zlib, `0xEDB88320`) over the body.

Risk notes: SWD access on a locked part may be disabled by customer
firmware (GPIO4/5 re-tasked via `GPIOx_FUNC_SEL`); pads are 0.35 mm pitch —
use flux + fine Enamel-pinned probes; never power 5 V into a 1.8 V rail.

## 3. UART bootloader — write-path recovery (GPIO2/3)

Not a dump, but the sanctioned **write** recovery path, straight from the
datasheet:

- GPIO2 = UART Rx, GPIO3 = UART Tx at power-on (FUNC_SEL=1).
- USB-UART bridge (CP2103/PL2303 class) at **≥ 921600 baud**; wire
  bridge-RxD→GPIO3, bridge-TxD→GPIO2, GND common.
- Speak the boot token protocol (`PROTOCOL.md` §3): KTM → KEY → CHP → CFG →
  PWO → KSTA → 0x69 blocks → STP. The vendor KT_BOOT_TOOL's
  `comboBox_baund` (115200/256000/576000/921600) is this exact interface.
- Use it to flash back a hardware dump or a patched factory BIN.

## 4. Software exceptions — what *does* read (v11 findings)

- **KT_BOOT_TOOL 1.0.58 contains `flash_read_all`** with a `./test.bin`
  output-path string, adjacent to `KTM_TT_V3_flash` / `KTSPI` menu /
  `checkBox_ktspi_test` (`VENDOR-TOOLS.md` §2b). This is the SPI-bridge
  read path for **KT0712-class devices with external SPI flash** — not the
  Helios internal flash. If you have a KT0712 dongle, the vendor tool may
  dump it as-is.
- **Run-mode `0x08` extended read**: reads the extended/RAM space, returns
  zeros on Helios runtimes — useful for live register/RAM inspection (now a
  first-class panel in the app), never for flash backup.
- **CDC bootloader**: 10 tokens, no read token; `INF` returns size + CRC-32
  only (identity check, not data).

## 5. Decision table

| Goal | Path |
|---|---|
| Live register/RAM inspection | App → Register Explorer / 0x08 dump |
| Full firmware backup (Helios) | SWD via GPIO4/5 (§2) — software path does not exist |
| Full firmware backup (KT0712, external SPI) | KT_BOOT_TOOL `flash_read_all` (§4) or SPI clip |
| Restore / reflash | Boot panel (WebHID), UART bootloader (§3), or KT_BOOT_TOOL |
| Migrate tuning to another unit | Patch a *matching-chip factory image* with the BIN Patcher — never a foreign image |
