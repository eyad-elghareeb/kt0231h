# DAC Control - KT0231H / KT0211L / KT02H20

Browser-based parametric EQ controller for **KTMicro** USB audio DSP dongles/cables.
Goal: fully working on all three chips — **KT0231H**, **KT0211L**, **KT02H20**.

Forked from https://github.com/gxcreator/kt02h20-control. Protocol description:
[`PROTOCOL.md`](PROTOCOL.md) — complete run-mode + bootloader reference reverse
engineered from the vendor `KT_USB_APP.exe` / `KT_BOOT_TOOL_1.0.58.exe` binaries
and their hex logs.

## Support matrix

| Chip | VID:PID | DAC EQ | Write ACK | Map status |
|------|---------|--------|-----------|------------|
| KT0231H | `0x31B2:0x1132` | 6 bands @ `0x35–0x40`, EN @ `0x34` | `0x4F` | Hardware-verified (dump + write/readback/restore, 2026-09-21) |
| KT0211L | `0x31B2:0x0111` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` | Hardware-verified (full dump + write ACK, 2026-09-21; seen as `CDS.KT USB Audio`, FW `CDSV100.003`) |
| KT02H20 | `0x31B2:0x0111` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` | Upstream-verified (ktmicro-tools, real hardware) |

KT0211L and KT02H20 share a VID:PID, so the app picks the profile by product
name first (`CDS…`/`0211…` → KT0211L, `KT02H20…`/`JM12…` → KT02H20) and falls
back to VID:PID (a name-wiped `0x0111` device lands on KT02H20, which is
register-identical for DAC EQ).

## What's new in v7 (this fork)

- **KT0231H ADC bank in the UI** — the second 6-band bank (EN `0x41`, bands
  `0x42–0x4D`) gets its own DAC/ADC toggle; Read/Write/toggle act on the
  selected bank, presets can carry both banks.
- **Volume controls vendor-confirmed** — `KT_USB_APP 1.0.17` + upstream
  register map pin the semantics: `0x3A` A_ADC PGA (idx → 0/−6/8/14/20/26/32/44 dB),
  `0x3B` A_DAC PGA (0 = mute, 1..15 → 1.5·(i−1)−18 dB), `0x65` DIG_ADC,
  `0x66` DIG_DAC (byte0 DACL, byte1 DACR on stereo models). Solid on
  KT0211L/KT02H20; on KT0231H those addresses are EQ regs, volume stays
  best-effort there.
- **Save to Flash (vendor `0x53` commit)** — the persistence answer: Write All
  Bands, then one click commits DSP RAM to flash (device reboots).
  KT0211L/KT02H20 only. See `PROTOCOL.md` §1.
- **Firmware persistence (BIN patch)** and **Boot-mode flasher** code paths
  (`FwBin`, `BOOT` in `app.js`) are retained but their UI cards were removed
  to keep things simple — BIN patch + `KT_BOOT_TOOL` reflash remains the
  fallback flow. Table layout double-confirmed against the Tanchjim KT0211L
  factory image (see `PROTOCOL.md` §4).
- **`PROTOCOL.md`** — the full byte-level reverse engineering (run mode,
  boot mode, image layout, vendor binary internals, open questions).
- `scripts/` — the Python RE toolchain used: log parser, checksum cracker,
  PE string/xref/disassembly helpers, firmware-image reconstructor.

## Quick start

1. Open the `index.html` Web UI in Chrome or Edge desktop (WebHID isn't supported in Firefox/Safari).
2. Click "Connect USB", select the KT USB device (profile is shown in the header after connect).
3. Read/write the DAC (and on KT0231H the ADC) EQ, toggle EQ on/off, adjust digital DAC gain.
4. For persistence (KT0211L/KT02H20): Write All Bands → Save to Flash →
   wait for the reboot → reconnect → Read back to verify.

> Linux: needs a udev rule for `/dev/hidraw*` access. If `device.open()` throws `NotAllowedError`, add:
> ```
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="1132", TAG+="uaccess"
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="0111", TAG+="uaccess"
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="0101", TAG+="uaccess"
> ```
> to `/etc/udev/rules.d/99-kt0231h.rules`, then `sudo udevadm control --reload && sudo udevadm trigger`.

## KT0231H register map (ASR post #560 + hardware verification)

Same HID protocol as KT02H20 (`0x4B` report, `0x52` read / `0x57` write) and same
per-band A/B encoding:

- A_reg = `[freq_Hz:16][gain×10:16 signed]`, B_reg = `[type][Q×1000]`
- Filter types: 0 Peak, 1 LPF, 2 HPF, 3 Low-Shelf, 4 High-Shelf
- Factory DAC defaults: 61/122/184/248/316/392 Hz, 0 dB, Peak, Q 0.700

| Dec | Hex | Content |
|-----|-----|---------|
| 52 | 0x34 | DAC EQ enable (= 1) |
| 53–64 | 0x35–0x40 | DAC bands #0–#5 (freq&gain / type&Q pairs) |
| 65 | 0x41 | ADC-side bank EQ enable (= 1) |
| 66–77 | 0x42–0x4D | ADC-side bank bands #0–#5, same defaults |

## Remaining known gaps (honest list, post-RE)

1. **Persistence: SOLVED via vendor SAVE (`0x53`) — user-verified on
   KT0211L.** Write All Bands → Save to Flash → reboot → settings survive
   replug. BIN patch + boot-reflash stays as fallback (untested here).
2. **Firmware dump: not possible in software — definitive.** Converging
   evidence (our disassembly + community decompiled-bootloader work):
   no read/dump token in the CDC bootloader (`INF` = size+CRC only),
   run-mode `0x08` reads unmapped space. The app has a read-only
   **Peek memory** (`0x08`) button for development visibility; true backup
   needs hardware access.
3. **KT0231H volume regs still unknown** (0x3A/0x3B are EQ regs there,
   0x65/0x66 read zero) — controls are best-effort on that chip only.
4. **KT0211L/KT02H20 EQ-enable reads `3`** — bit1 meaning unknown; app
   preserves it (writes `val|1` / `val&~1`).
5. **Vendor `0x69` block tail** (4 bytes per 1024 B block) not fully cracked —
   upstream format without tail is hardware-proven; captured tails + analysis
   in `PROTOCOL.md` §7 for future work.
6. **The `0x43` handshake must not be sent** on KT0231H (stalls the HID pipe);
   the app never sends it. Same for boot entry `0x54` — documented only,
   never sent.
7. Vendor `KT_USB_APP` device list skipped the test dongle because of its
   keyboard/mouse filter heuristics (disassembled) — not a protocol issue.
