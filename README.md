# DAC Control — KT0231H / KT0211L / KT02H20 / KT0210 (Bunny DSP)

Browser-based parametric EQ controller for **KTMicro** USB audio DSP
dongles/cables (昆腾微 / Quantum Micro, VID `0x31B2`).
Forked from `gxcreator/kt02h20-control`; this improved fork adds the Tanchjim
Bunny DSP, a full firmware/tool forensics baseline, and the complete vendor
chip roster. Byte-level protocol: [`PROTOCOL.md`](PROTOCOL.md).
Chip family field guide + "is X the same chip as Y": [`CHIPS.md`](CHIPS.md).
Collected factory firmware images: [`FIRMWARES.md`](FIRMWARES.md) + `firmware/`.
Vendor tool disassembly findings: [`VENDOR-TOOLS.md`](VENDOR-TOOLS.md).
CPU core, image format & hardware ports (SWD/UART): [`ARCHITECTURE.md`](ARCHITECTURE.md).
Firmware dump & recovery paths: [`HARDWARE-DUMP.md`](HARDWARE-DUMP.md).

## Support matrix

| Chip | VID:PID | DAC EQ | Write ACK | Save (0x53) | Map status |
|------|---------|--------|-----------|-------------|------------|
| KT0231H | `0x31B2:0x1132` | 6 bands @ `0x35–0x40`, EN @ `0x34` | `0x4F` | unverified | Hardware-verified (dump + write/readback/restore, 2026-09-21) |
| KT0211L | `0x31B2:0x0111` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` | ✅ | Hardware-verified (full dump + write ACK + save, 2026-09-21; `CDS.KT USB Audio`, FW `CDSV100.003`) |
| KT02H20 | `0x31B2:0x0111` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` | ✅ | Upstream-verified (ktmicro-tools, real hardware) |
| **KT0210** (new in v8) | `0x31B2:0x1112` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` | ✅ (USB re-enum) | Cross-verified via bunnyeq REGISTER-MAP (fw v1.01 probe + Tanchjim APK decompile) + BunnyDSPLinux |
| **KT02F20** (new in v10) | `0x31B2:0x0111` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` (assumed) | ⚠️ expected, unverified | Image-confirmed Helios layout — two vendor SDK builds, tag `KT_Helios_v1b___KT02F20B` (`FIRMWARES.md` §2b) |
| **KT02F21/F22, KT02H22, KT0210S** (new in v10) | TBD | expected Helios 5-band | assumed `0x03` | ⚠️ expected | Name-matched profiles from the KT_BOOT_TOOL roster — probe on hardware and report |
| KT020x (MSV2B), KT0712, KT70022/KT1200 | — | **no run-mode map** | — | — | Documented only (`ARCHITECTURE.md` §4) — different/no known architecture |

KT0211L and KT02H20 share a VID:PID, so the app picks the profile by product
name first (`CDS…`/`0211…`/`TANGZU…`/`WAN'ER…` → KT0211L, `KT02H20…`/`JM12…` →
KT02H20) and falls back to VID:PID. The Bunny DSP (`TANCHJIM BUNNY DSP`, chip
ID `TURN2CDC`) has its own PID `0x1112` so it matches unambiguously.
**Tangzu Wan'er 2 DSP** is owner-reported to be a KT0211L device — expect
`31B2:0111` on the bus (details in `CHIPS.md` §1).

## What's new in v11 (this fork)

- **Device ID & chip prober** — read-only fingerprint of any KT dongle:
  version/build/USB strings, flags (single-DAC bit), packed VID:PID, magic,
  plus a band-register layout discriminator (0x26 vs 0x35) that names the
  chip class even on unknown OEM product strings — with one-click profile
  override (all 10 profiles selectable).
- **USB identity editor (rename your dongle)** — write manufacturer /
  product / serial strings (0x40–0x56) and VID:PID (0x5B) with confirm
  gates; replug to see, persist via Save to Flash where supported.
- **Mic / ADC chain** — the DAC/ADC bank toggle now covers Helios profiles:
  ADC-side (mic) 5-band EQ @ 0x1A–0x23, EN 0x18 (upstream-verified on
  KT02H20), alongside the existing A_ADC PGA + DIG_ADC controls.
- **DRC panel** — Noise Gate (EN, threshold, gate volume, AT/RT) and
  Limiter (EN, SOFT, threshold, AT/RT) writing 0x71–0x73 / 0x78–0x79 with
  the vendor 256+dB threshold encoding; readback on connect.
- **Register Explorer** — full 0x00–0xFF dump with annotated known
  registers, JSON/CSV export; **0x08 extended-space dumper** (start/count,
  .bin export) honestly labeled per PROTOCOL.md §9.1.
- **AutoEQ import** — drop any AutoEQ-style parametric JSON
  (`{filters:[{type,frequency,gain,q}]}`) straight onto the DAC bank with
  filter-type mapping.
- **Dump-path RE (KT_BOOT_TOOL `flash_read_all` → `./test.bin`)** — new
  string-context evidence of a vendor flash-read scoped to the KTSPI /
  KT0712 external-SPI bridge flow; Helios internal flash verdict unchanged
  (`PROTOCOL.md` §10.1, `VENDOR-TOOLS.md` §2b).
- **`HARDWARE-DUMP.md`** — the complete backup/recovery guide: SWD on
  GPIO4/5 (adapter + procedure + risks), UART bootloader write path
  (GPIO2/3 @ ≥921600), memory map, and the §5 decision table.
- New RE tooling: `scripts/kt_boot_tokens.py` (vendor-token scanner).

## What's new in v10 (this fork)

- **Chip support expanded to 9 profiles**: new KT02F20 (image-confirmed
  Helios map, PID `0x0111`), KT02F21, KT02F22, KT02H22 and KT0210S
  (name-matched from the vendor roster; the app never sends save or
  unverified commands to them). MSV2B (KT020x) and KT0712 are deliberately
  **not** profiled — different architectures with no known run-mode map.
- **New `ARCHITECTURE.md`** — the firmware-internals reference: CPU core
  identified as **Andes AndeStar v3 (NDS32)** (Ghidra ISA bake-off, 94 %
  coverage vs <11 % for everything else), the full image-header format
  (`flash-tag + chip-id + Size + ENTY`, load mapping `file 0x3000 = RAM
  0x83000`), and the hardware-access map — **SWD on GPIO4/5, UART bootloader
  on GPIO2/3 @ ≥921600 baud, I²C on GPIO0/1** — straight from the vendor
  KT02F20 datasheet. Includes the nds32le-elf-gcc toolchain path for
  custom-firmware experiments.
- **`PROTOCOL.md` §9** — new protocol material: full `0x08` extended-read
  semantics (two address regimes, hardware-disproven as a backup path),
  hardware-validated CDC bootloader behaviours (one-shot state machine, CHP
  sum8 checksum live captures, ZRST caveats, canonical CRC-32), and
  datasheet-anchored register semantics (`DRC_EN`/`DRC_TH`, `ADC_FILT_CFG_0`,
  sidetone regs).
- **`scripts/kt_img_header.py`** — structural header parser for every
  KTMicro platform; its output table is baked into `FIRMWARES.md` §2b.
- Routing regression-tested (9 name/VID:PID cases, incl. Tangzu → KT0211L
  and nameless `0x0111` → KT02H20 precedence).

## What's new in v9 (this fork)

- **Full UI redesign — "instrument console" theme.** New deep-graphite lab
  aesthetic with mint signal accent, monospace numerics, indexed sections
  (01–07), LED status strip, chip badges in the app bar, and a new workspace
  grid: full-width response graph on top, EQ workspace left, transport /
  gain / presets / firmware-tools sidebar right, USB log docked at the
  bottom. Canvas re-themes via CSS custom properties; band gain tints are
  now mint (boost) / rose (cut).
- **Firmware tools panels restored in the markup.** The Firmware BIN Patcher
  (load → inspect → patch → export `_new.bin`) and the Boot-mode Flasher
  (boot-PID connect, info, `FLASH` confirm gate, progress bar) existed in
  `app.js` since v7, but the v8 HTML rewrite had dropped their DOM. Both are
  back (sections 05/06 in the sidebar).
- **Tangzu Wan'er 2 DSP → KT0211L.** Owner-reported chip identity (see
  `CHIPS.md` §1). The app now routes `TANGZU` / `WAN'ER` / `WANER` product
  strings to the KT0211L profile, and the device legend in the UI footer
  documents the routing.

## What's new in v8 (this fork)

- **Tanchjim Bunny DSP (KT0210) support** — new device profile (PID `0x1112`),
  register map from vzpyr/bunnyeq hardware probing + Tanchjim APK analysis:
  same 5-band EQ layout, mic gain `0x65` / DAC volume `0x66` (0.5 dB steps),
  vendor SAVE `0x53` confirmed to persist (device re-enumerates USB after).
- **`supportsSave` profile flag** replaces the hardcoded pid-0x0111 save gate —
  SAVE now offered to every profile with verified semantics, still never on
  KT0231H.
- **`CHIPS.md`** — the complete chip-family comparison: KT0231H vs KT0211L vs
  KT02H20 vs KT02F20 vs KT0210(Bunny) vs MSV2B/KT020x vs KT0712, with the
  firmware-platform lineage (`KT_Helios_v1b` / `KT_lnv1b`, `KT_msv2b`,
  `KTM_TT_V3`) and the definitive "same chip?" answers, including the Tanchjim
  Bunny vs DSP S case and the (unconfirmed) Tangzu Wan'er 2 DSP situation.
- **`FIRMWARES.md` + `firmware/`** — eight vendor images with hashes and
  forensic layout maps: Tanchjim DSP S v1.0.2 (official zip), TINHIFI KT02H20,
  KT02F20 SDK ×2 (jack variants), KT0712 SDK V2.1 + reset loader (carved out
  of KT_BOOT_TOOL's Qt resources), and the MSV2B `KT0206_boot_v1.05` RAM
  loader with its `KTCInitKey`/`KTPrgKey` unlock strings.
- **`VENDOR-TOOLS.md`** — the four vendor EXEs (KT_USB_APP 1.0.17,
  KT_BOOT_TOOL 1.0.58, the undocumented **KT Upgrade Tool 1.2.10**, and
  kt_usb_cmd_tool 1.3.16 carved from Tanchjim's boot tool): hashes, sources,
  Qt-resource carve map, and what the disassembly settled — the full 17-chip
  vendor roster, boot PID `31B2:0001` confirmation, flash-name selection table,
  and re-confirmation that no firmware-read primitive exists anywhere.
- **`scripts/`** — new tooling: `kt_fw_analyze.py` (image forensics),
  `kt_rcc_walk2.py` (Qt resource carver), `kt_chip_xrefs.py`, `kt_strings.py`,
  `kt_reg_scan.py` on top of the existing RE toolchain.
- v7 highlights kept: KT0231H ADC bank UI, vendor-confirmed volume semantics,
  Save-to-Flash, BIN patcher + boot-mode flasher paths.

## Quick start

1. Open the `index.html` Web UI in Chrome or Edge desktop (WebHID isn't supported in Firefox/Safari).
2. Click "Connect USB", select the KT USB device (profile is shown in the header after connect).
3. Read/write the DAC (and on KT0231H the ADC) EQ, toggle EQ on/off, adjust digital DAC gain.
4. For persistence (KT0211L/KT02H20/KT0210): Write All Bands → Save to Flash →
   wait for the reboot → reconnect → Read back to verify.

> Linux: needs a udev rule for `/dev/hidraw*` access. If `device.open()` throws `NotAllowedError`, add:
> ```
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="1132", TAG+="uaccess"
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="0111", TAG+="uaccess"
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="0101", TAG+="uaccess"
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="1112", TAG+="uaccess"
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

Helios-class (KT0211L/KT02H20/KT0210) factory defaults: 1000/2000/5000/8000/
10000 Hz, Q 0.707, 0 dB, Peak — matching the EQ tables embedded at the same
offsets (`0x106A`/`0x109A`) of every factory image in `firmware/`.

## Remaining known gaps (honest list, post-RE)

1. **Persistence: SOLVED via vendor SAVE (`0x53`)** — user-verified on
   KT0211L, community-verified on Bunny DSP. BIN patch + boot-reflash stays
   as fallback (untested here).
2. **Firmware dump: not possible in software — definitive.** Re-confirmed in
   v8 against the carved `kt_usb_cmd_tool` CLI and the MSV2B boot image: no
   read/dump token anywhere. True backup needs hardware access (SWD/SPI).
3. **KT0231H volume regs still unknown** (0x3A/0x3B are EQ regs there,
   0x65/0x66 read zero) — controls are best-effort on that chip only.
4. **KT0211L/KT02H20 EQ-enable reads `3`** — Bunny firmware v1.01 shows the
   same register holds `0x03` (custom EQ active) vs `0x02` (bypass), so bit1
   likely means "custom EQ bank loaded"; app still preserves unknown bits.
5. **Vendor `0x69` block tail** (4 bytes per 1024 B block) not fully cracked —
   the most promising lead is now the 162,307-B NDS32 loader blob carved from
   KT_BOOT_TOOL (see `VENDOR-TOOLS.md` §3).
6. **The `0x43` handshake must not be sent** on KT0231H (stalls the HID pipe).
7. **Tangzu Wan'er 2 DSP**: owner-reported as **KT0211L** (same die class as
   Tanchjim DSP S). Still no Tangzu app or published firmware — plug it in,
   confirm `31B2:0111`, and the app should route it via the `TANGZU`/
   `WAN'ER`/`WANER` name keys (see `CHIPS.md` §1).
8. **KT0210 band-count discrepancy**: 5-band (fw v1.01 probing) vs 8-band
   (BunnyDSPLinux) — needs a fw-versioned map; the app ships the 5-band map.
