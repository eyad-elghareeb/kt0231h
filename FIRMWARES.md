# Collected KTMicro Firmware Images — Inventory & Forensics

All images ship in `firmware/`. Every file's provenance, hash and internal
layout is documented here so nobody flashes something they can't trust.
Verify SHA-256 before flashing anything.

## 1. Inventory

| File | Chip / family | Size | SHA-256 (first 16) | Source |
|---|---|---|---|---|
| `TANCHJIM_DSP_S_KT0211L_20240815_v1.0.2.bin` | KT0211L (Tanchjim DSP S) | 42,272 B | `a8dc36cc5710d049` | Official Tanchjim DSP S upgrade zip V1.0.2 (`tanchjim.com/en/dsps-upgrade/`, CloudFront `1875933634511282176%2Fde3560213f76846d44d7a10d2398a9da.zip`, dir `tanchjim_dsps_upgrade_20240913/`) |
| `KT0211L_FISSION_v1.0.2_250610.bin` | KT0211L (Tanchjim Fission) | 42,272 B | `9abe8e0b2ad97a86` | Official Tanchjim Fission upgrade package, build 2025-06-12 (`tanchjimaudio.com/app-services`, CloudFront, dir `tanchjim_fission_upgrade_20250612/`) — one generation newer than the DSP S image, same die class and same 42,272 B size |
| `KT0211L_fission_rational_hifi_edition_v1.0.1_20250610.bin` | KT0211L (Fission Rational HiFi Edition) | 43,440 B | `9abe7c7cff44c7e6` | Official Tanchjim upgrade package, build 2025-06-12 (CloudFront `3593ce3b…`). 1,168 B larger than the Fission image — a different OEM feature set, still KT0211L |
| `KT02H20_TINHIFI_20240328_v1.0.1.bin` | KT02H20 (TINHIFI build) | 62,784 B | `9aca008fbc8a7faf` | Shipped inside the KT_USB_APP.zip vendor package (oshwhub `abd1556a453f4bd9b2ab419a47526bc2.zip`), alongside `KT02H20_1.0.17.ini` |
| `KT02F20_SDK_20250206_disable_jack.bin` | KT02F20 (SDK, jack detect off) | 61,632 B | `96eee5f5fa6b4531` | oshwhub KT02F20 project `40fbb08fbb8246a4b9d1fb7f57fcf465.bin` |
| `KT02F20_SDK_20250206_jack_GPIO_03.bin` | KT02F20 (SDK, jack detect on GPIO3) | 61,632 B | `99f76001f5d25ffe` | oshwhub KT02F20 project `3aceb6dd52434d7c9707dd429d536834.bin` |
| `KT0712_SDK_V2.1_20230724.bin` | KT0712A (KTM_TT_V3 platform) | 160,400 B | `16cd1ae5fe9465f2` | Carved from KT_BOOT_TOOL_1.0.58.exe Qt resource `:/res/…` (file offset `0xfbd841`) — see `VENDOR-TOOLS.md` |
| `KT0206_boot_v1.05_20210608.bin` | MSV2B boot loader (KT020x) | 17,424 B | `4560861a53128ff0` | Carved from TANCHJIM_DSPS_BOOT_TOOL_1.0.03.exe → embedded `kt_usb_cmd_tool.exe` v1.3.16 resource (zlib @ `0x4192c8` of the carved tool) — matches the default boot image name `KT0206_boot_v1.05_20210608.bin` in its CLI strings |
| `KT0712_reset_spi_part1_224B.bin` / `part2_32B.bin` | KT0712 SPI-reset loader pieces | 224 B + 32 B | `4eb9f344ff0c40bd` / `bd2aea413e497f91` | Carved from KT_BOOT_TOOL_1.0.58.exe resource array (`0xfe4ad5`, `0xfe4bb9`) |

These are vendor-published / vendor-embedded images (not dumps): redistributing
them alongside full source attribution is what every existing RE repo already
does with the DSP S image. **Never flash a foreign image** — persist-flash must
patch the unit's own backup (`PROTOCOL.md` §5).

## 2. Meta block anatomy (all images)

Every image starts with the meta header the bootloader's `0x69 sub 0xF0` block
carries verbatim (`PROTOCOL.md` §3 "Meta block layout"):

```
<flash tag>\<chip-id>00        e.g. "KT_lnv1b_flash_1" + "0211LC02"
"Size" + u32 LE <payload bytes>
<build-tag> + <build-no>       e.g. "f0" + "15275"
YYYY-MM-DD (or "Mon DD YYYY")  build date
"ENTY" + u32 LE ×N             entry point(s)
```

KT0206 boot loader additionally embeds the ASCII keys `KTCInitKey`, `KTPrgKey`,
tag `BFLSH`, banner `MSV2B_BOOT`, and a "Factor Menu V1.0 / 0.DownLoad Flash"
console menu.

### 2b. Parsed header table (`scripts/kt_img_header.py`)

The structural parser (v10) verifies the header anatomy above byte-exact on
every shipped image — run `python3 scripts/kt_img_header.py` to reproduce:

| Image | Flash tag | Chip ID | Size field | ENTY |
|---|---|---|---|---|
| TANCHJIM_DSP_S (0211L) | `KT_lnv1b_flash_1` | `0211LC02` | 42,272 = file | `0x8b000` ×2 |
| KT02H20_TINHIFI | `KT_Helios_v1b___` | `KT02H20B` | 62,784 = file | `0x83000`, sz `0x1d188` |
| KT02F20_SDK ×2 | `KT_Helios_v1b___` | `KT02F20B` | 61,632 = file | `0x83000`, sz `0x1d188` |
| KT0206_boot 1.05 | `KT_msv2b_flash_` | `020xB04` | 45,160 (target img) | — |
| KT0712_SDK V2.1 | `KTM_TT_V3_flash_` | `KT0712A` | 160,400 = file | — |

Header layout + load-address mapping (`file 0x3000 = load 0x83000`, base
`0x80000`, header stripped before write) is documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §2 — the image is an NDS32 (Andes
AndeStar v3) build, not ARM/RISC-V.

## 3. Helios-class common layout (0211L / 02H20 / 02F20)

Forensically identical section map across the three chips — this is the strongest
evidence they are one platform ("KT_Helios_v1b" build stamp appears inside the
KT02H20/KT02F20 images; the Tanchjim 0211L image is the smaller production cut):

| Offset | Content |
|---|---|
| `0x0000` | meta block (flash tag + chip id + size + build + ENTY) |
| `0x1000` | `REG:` factory register defaults block; bytes 4-6 differ per build (`01 00 00` on Tanchjim 1.0.2, `00 02 00` on TINHIFI/02F20 1.0.1) followed by version "1.0.x", build date, build time |
| `0x106A` | DAC EQ table, 5 × 8 B entries `[freq u16][Q×1000 u16][gain×10 s16][type u16]` — factory 1000/2000/5000/8000/10000 Hz, Q 0.707, 0 dB, Peak |
| `0x109A` | ADC EQ table, same 5-entry format |
| `0x10E8` | bank-enable byte (adcOff+0x4E) = `0x03` (bit0 DAC, bit1 ADC) |
| `~0xA0F8` / `0x116C` | USB device descriptors, VID `0x31B2` PID `0x0111` (Tanchjim & 02F20 images) |
| `0x1120` | product ASCII ("TANCHJIM-DSP S", "USB Audio", "USB-C Audio") |

KT02H20_TINHIFI differs only in: no `31B2` descriptor hit at `0x116C` in our
scan (product "USB-C Audio"), same EQ/REG offsets. The 02F20 pair demonstrates
the vendor SDK's per-hardware-config builds (jack detect toggle), i.e. what
OEMs receive and rebrand.

## 4. What the images do NOT contain

- No UTF-16 strings (USB strings are built at runtime from ASCII).
- No KT0231H image anywhere in the vendor packages we recovered — KT0231H
  factory images have never been publicly distributed. If you have a KT0231H
  dongle, its only backup is a hardware SWD/SPI dump (software readback is
  provably absent from the whole vendor toolchain — `PROTOCOL.md` §7.7).
- The KT0712 SDK image has no Helios `REG:`/EQ structure (different platform).

## 5. Reproduce the forensics

```
python3 scripts/kt_img_header.py      # header/flash-tag/ENTY table (all images)
python3 scripts/kt_fw_analyze.py      # image-by-image report (this file §2-3)
python3 scripts/kt_rcc_walk2.py       # carve Qt resource payloads from the EXEs
python3 scripts/kt_chip_xrefs.py      # chip-name xrefs in vendor binaries
python3 scripts/kt_strings.py         # targeted string extraction
```
