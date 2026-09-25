# KTMicro USB-Audio Chip Families — Field Guide & Comparison

Compiled 2026-09 from firmware image forensics (see `FIRMWARES.md`), vendor-tool
disassembly (see `VENDOR-TOOLS.md`), community RE (vzpyr/bunnyeq, onbot7,
ParkWardRR, Ircama, gxcreator) and live hardware verification in this repo.
Companion to `PROTOCOL.md` (byte-level protocol) — this file answers
"*which chip is in my dongle, and is it the same die as that other dongle?*".

## 1. TL;DR matrix

| Chip | Run VID:PID | Chip-ID string | Families seen in the wild | EQ (run-mode) | Save 0x53 | Image platform |
|---|---|---|---|---|---|---|
| **KT0231H** | `31B2:1132` | — | Moondrop-style dongles, warmseaic modules | 6-band DAC `0x35–0x40` + 6-band ADC `0x42–0x4D`, EN `0x34`/`0x41` | **unverified** (regs 0x3A/0x3B are EQ here) | separate (Helios-class 6-band) |
| **KT0211L** | `31B2:0111` | `0211LC02` | Tanchjim DSP S ("CDS.KT USB Audio"), **Tangzu Wan'er 2 DSP** (owner-reported) | 5-band `0x26–0x2F`, EN `0x24` | verified | `KT_lnv1b` / "KT_Helios_v1b" |
| **KT02H20** | `31B2:0111` | `KT02H20B` | FiiO JA11, JCALLY JM12, Moondrop KT02, TINHIFI | 5-band `0x26–0x2F`, EN `0x24` | verified | `KT_Helios_v1b` |
| **KT02F20** | `31B2:0111` | `02F20B` | vendor SDK reference designs (mic + GPIO3 variants) | 5-band `0x26–0x2F` (image layout identical to 0211L/02H20) | expected (same family) | `KT_Helios_v1b` |
| **KT0210** | `31B2:1112` | `TURN2CDC` (report 0x54) | **Tanchjim Bunny DSP** | 5-band `0x26–0x2F` (fw v1.01; 8-band reported on newer fw) | verified (USB re-enum) | Helios-class |
| KT02H22 | `31B2:?` | — | named in KT_BOOT_TOOL roster + warmseaic blog vs ALC4080 | expected Helios 5-band (profile added v10, name-matched) | unverified | Helios-class (expected) |
| KT0210S | `31B2:?` | — | named in KT_BOOT_TOOL roster (between 0211L and 0231H) | expected Helios 5-band (profile added v10, name-matched) | unverified | Helios-class (expected) |
| KT02F21 / KT02F22 | `31B2:?` | — | named in KT_BOOT_TOOL roster (02F2x siblings of F20) | expected Helios 5-band (profiles added v10, name-matched) | unverified | Helios-class (expected) |
| KT0211 (base) | `31B2:?` | — | roster slot 5; likely the 0211L die at a different SKU | — | — | — |
| KT0200/KT0201/KT0203N/KT0206/KT020X | boot PID `31B2:0001`-class | `020xB04` | MSV2B family, `KT_msv2b_flash` | **no run-mode map known** — do not send 0x4B reports blindly | — | **MSV2B** (different boot arch) |
| KT0712 / KT0712A | — | `KT0712A` | embedded SDK fw in KT_BOOT_TOOL (USB→I2S bridge family) | **no run-mode map known** | — | **KTM_TT_V3** (different arch) |
| KT70022 / KT1200 | — | — | named in KT_BOOT_TOOL roster only | — | — | — |

**"Is X the same chip as Y?" quick answers:**

> **v11 prober:** for any unknown KT dongle, the app's *Device ID* card now
> answers this empirically — it fingerprints the identity registers and
> discriminates Helios vs KT0231H layouts by which address (0x26 vs 0x35)
> holds a band A-reg (`PROTOCOL.md` §10.2). See also §2b below.

- *Tanchjim DSP S vs Tanchjim Bunny DSP* → **NO.** DSP S = KT0211L (`31B2:0111`,
  flash tag `KT_lnv1b_flash_10211LC02`), Bunny DSP = KT0210 (`31B2:1112`,
  chip ID `TURN2CDC`). Different PIDs, different chip IDs, same vendor protocol.
- *Tanchjim DSP S vs FiiO JA11 / JCALLY JM12 / Moondrop KT02* → **same die
  class** as KT02H20 (identical image layout: `REG:` defaults @ `0x1000`, DAC EQ
  @ `0x106A`, ADC EQ @ `0x109A`, bank-enable @ `0x10E8`, USB descriptors at the
  same offsets; PID `0x0111`). Register-identical for DAC EQ in practice.
- *Tangzu Wan'er 2 DSP* → **KT0211L (owner-reported).** No Tangzu app, no
  published firmware and no teardown exist anywhere public (checked:
  tangzu.net, APK stores, forums, 52audio, GitHub) — but the owner community
  consistently reports the Wan'er 2 DSP as a KT0211L device, which fits the
  OEM channel (same KTMicro DSP-cable pipeline as Tanchjim). Expected USB
  identity: `31B2:0111`, likely a `CDS…`-style or `TANGZU WAN'ER…` product
  string. This app routes `TANGZU`/`WAN'ER`/`WANER` strings to the KT0211L
  profile; if you own one, verify the VID:PID and the EQ layout with a Read.
  Older "KT0231H" attribution was speculative and is considered superseded.
- *Moondrop CHU 2 DSP* → **not KTMicro at all.** Its firmware (see
  `../download/Moondrop_CHU2_DSP_firmware_v1.0.0.bin` from the companion
  Moondrop RE project) is a Bestechnic (BES) ARM Cortex-M image — a different
  vendor entirely. Moondrop's "KT02" dongle is the KTMicro one.

## 2. Family silicon traits (KT02F20 datasheet V0.5, CN — applies Helios-wide)

Hardware-level facts from the vendor datasheet (full extraction in
`ARCHITECTURE.md` §3): 5-band EQ per path (mic + DAC) in silicon; DRC with
`DRC_EN` + `DRC_TH<3:0>`; input PGA via `ADC_FILT_CFG_0`; sidetone
`SIDETONE_L/R_VOL`; 2 Mbit internal flash with UART bootloader (GPIO2/3,
≥ 921600 baud) plus USB update; **SWD on GPIO4/5**; 6-ch 8-bit AUX ADC;
auto OMTP/CTIA; ≤ 4 configurable keys; QFN-36 4×4 mm; internal osc, dual
DCDC. CPU core = **Andes AndesTar v3 (NDS32)** — see `ARCHITECTURE.md` §1.

### 2b. Image platform lineages (firmware forensics)

All factory images we handle start with a meta block:
`<flash tag>\<chip-id>00 "Size" + u32 LE <payload-size>` then build/version
strings and `ENTY` + entry points. `REG:` factory-default blocks live at
`0x1000` on the Helios class.

| Platform | Flash tag seen | Images confirming | Notes |
|---|---|---|---|
| **KT_lnv1b / "KT_Helios_v1b"** | `KT_lnv1b_flash_1` + chip id (`…10211LC02`) or `KT_Helios_v1b___KT02H20B` / `…KT02F20B` | Tanchjim DSP S 1.0.2 (42,272 B), TINHIFI KT02H20 (62,784 B), KT02F20 SDK ×2 (61,632 B) | Identical section layout across all three chips (see `FIRMWARES.md` §3). EQ tables at the same file offsets. USB descriptors: VID `0x31B2`, PID `0x0111`. |
| **KT_msv2b** | `KT_msv2b_flash__020xB04`, `KT_msv2b_flash_1` | KT0206 boot loader 1.05 (17,424 B) | MSV2B_BOOT loader with `KTPrgKey`/`KTCInitKey` key strings, `BFLSH` tag, factory menu "0.DownLoad Flash". Boot-time USB descriptor VID `0x31B2` PID `0x0001` — confirms the boot-mode PID triple in the app's boot panel. |
| **KTM_TT_V3** | `KTM_TT_V3_flash_KT0712A` | KT0712 SDK V2.1 (160,400 B, carved out of KT_BOOT_TOOL's Qt resources) | Different architecture (KT0712 = USB→I2S bridge family; flash name `KTM_TT_V3_flash_1` per KT_BOOT_TOOL disassembly). |

## 3. Full vendor chip roster (from KT_BOOT_TOOL_1.0.58 comboBox code)

Order = comboBox index in the vendor tool:

```
0: KT0200   1: KT0201   2: KT0203N  3: KT0206   4: KT0210   5: KT0211
6: KT0211L  7: KT0210S  8: KT0231H  9: KT02H20 10: KT02H22 11: KT02F20
12: KT02F21 13: KT02F22 14: KT70022 15: KT1200  16: KT0712
```

Flash-name selection (disassembled from KT_BOOT_TOOL `.rdata` constants):

| chip family | flash name constant |
|---|---|
| KT02H2x / 0211L / Helios | `KT_lnv1b_flash_1` |
| MSV2B (KT020x) | `KT_msv2b_flash_1` |
| KT0712 | `KTM_TT_V3_flash_1` |

## 4. Run-mode register protocol — common core

Identical 11-byte HID report framing on every Helios-class chip (details in
`PROTOCOL.md` §1–2): report ID `0x4B`, payload `[addr LE32][cmd][0][value LE32]`,
commands `0x52` read / `0x57` write / `0x53` save / `0x43` handshake. Per-chip
differences that actually matter:

| Property | KT0231H | KT0211L | KT02H20 | KT0210 Bunny |
|---|---|---|---|---|
| Write ACK | `0x4F` | `0x03` | `0x03` | `0x03` class (fire-and-forget per bunnyeq) |
| EQ enable encoding | `0x34`=1 | `0x24` reads **3** (bit1 purpose unknown; preserve bits) | `0x24` | `0x24`: `0x03`=custom EQ on, `0x02`=bypass |
| Bands | 6+6 | 5 | 5 | 5 (fw v1.01; 8 on newer fw per BunnyDSPLinux) |
| Mic/ADC gain `0x65` | reads 0 | 0.5 dB steps, signed | same | −60…+12 dB, `dB*2` signed |
| DAC volume `0x66` | reads 0 | byte0=DACL byte1=DACR, 0.5 dB steps | same | −60…0 dB per channel, `dB*2`, both channels in one write |
| Save `0x53` | not verified | reboots | reboots | reboots + USB re-enumeration (~200–500 ms) |
| Handshake `0x43` | **stalls pipe — never send** | vendor sends it | vendor sends it | bunnyeq labels it "Clear/Reset" |
| Extra reports | — | — | — | `0x54` feature report = chip ID `TURN2CDC` |

Factory EQ defaults tell images apart: Helios vendor images ship
1000/2000/5000/8000/10000 Hz Q0.707 Peak; KT0231H ships 61/122/184/248/316/392 Hz
Q0.700 Peak.

## 5. Boot mode across families

- Helios class (0211L/02H20/KT0231H…): boot PID `31B2:0101` (also `:0001`/
  `:0002` in vendor templates — the KT0206 boot loader image literally embeds
  descriptor VID:PID `31B2:0001`). CDC serial `8888:cdc0` after HID `0x54`
  + `"T12345678"`; frame tokens KTM/VER/KEY/CHP/CFG/PWO/KSTA/0x69/STP —
  `PROTOCOL.md` §3.
- MSV2B (KT020x): `kt_usb_cmd_tool` picks HID (`-m`) vs serial (`-s`)
  transport per family; default boot image `KT0206_boot_v1.05_20210608.bin`
  (we extracted the exact bytes — `firmware/KT0206_boot_v1.05_20210608.bin`).

## 6. Sources & confidence

- **Hardware-verified**: KT0231H map (this repo, 2026-09-21), KT0211L map +
  save (this repo), KT02H20 (upstream ktmicro-tools).
- **Cross-referenced, no hardware**: KT0210 Bunny (bunnyeq + BunnyDSPLinux),
  KT02F20/KT0712/MSV2B (image forensics this repo), chip roster (vendor binary).
- **Unsourced**: KT02H22/KT70022/KT1200 details (names only); Tangzu Wan'er 2
  DSP chip identity rests on a consistent owner report (no hardware dump yet).
