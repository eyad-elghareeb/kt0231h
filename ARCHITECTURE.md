# KTMicro Firmware Architecture — CPU Core, Image Format & Ports

Compiled 2026-09 from a Ghidra ISA bake-off on the `JadeAudio JA11_V2.2.bin`
image (ParkWardRR, `ktflash` toolkit — hardware-confirmed CDC bootloader RE),
this repo's image forensics (`FIRMWARES.md`, `scripts/kt_img_header.py`) and
the vendor `KT02F20` datasheet V0.5 (CN, oshwhub). Companion to
[`PROTOCOL.md`](PROTOCOL.md) (USB protocol) and [`CHIPS.md`](CHIPS.md)
(chip family guide). This file answers "*what is actually running on the
silicon, and how do I get at it?*".

## 1. CPU core — Andes AndesTar v3 (NDS32), confirmed

KTMicro publishes the core of the Helios family nowhere. It was identified
empirically by importing the raw code region into Ghidra and running
auto-analysis under every ISA it ships, then scoring byte coverage and
decompiler sanity over the ~38 KB code region:

| Candidate ISA | Bytes covered | Functions | Verdict |
|---|---|---|---|
| ARM Cortex-M/thumb | ~11 % | 5, bogus coprocessor/halt garbage | wrong |
| RISC-V RV32 | ~6 % | 17, constructor errors | wrong |
| RISC-V AndeStar v5 | ~5 % | 15, same failure mode | wrong |
| MIPS / MIPS16e / TriCore / Xtensa | <5 % | 1–2, garbage | wrong |
| **NDS32 (AndeStar v3), LE** | **~94 %** | **95, clean decompiles** | **correct** |

The NDS32 decompile is not just "fewer bad instructions" — it is semantically
sane C with named Andes toolchain intrinsics: `setgie(0)` / `setgie(1)`
(`__nds32__setgie_en`/`_dis`, global-interrupt enable) and `dsb()` (data-sync
barrier) bracketing obvious critical sections. The Helios family
(KT0211L/KT02H20/KT02F20, KT0231H) is therefore a **licensed Andes AndesTar
v3 32/16-bit mixed-length RISC core** — a real, documented ISA, unlike the
closed cores in JieLi/Actions dongles. The carved 162,307-B RAM loader blob
in KT_BOOT_TOOL (`VENDOR-TOOLS.md` §3) is the same ISA, which is why it has
no readable strings until disassembled with an NDS32 backend.

Practical consequence: **Ghidra ships NDS32 support out of the box**, and a
mainline GCC exists (`nds32le-elf-gcc`, upstreamed since GCC 4.9/binutils
2.25 by Andes; prebuilt toolchains at `andestech/nds-gnu-toolchain`, packaged
on Arch as `nds32le-elf-gcc`). Custom-firmware *building* is a realistic
path, not just reading.

## 2. Image header format (all platforms)

Every KTMicro image starts with the meta block the bootloader's `0x69 sub
0xF0` write carries verbatim. Verified byte-exact across all eight images in
`firmware/` — parse it yourself with `python3 scripts/kt_img_header.py`:

```
<flash-tag><chip-id>[NUL] "Size" <u32 LE payload size> <build tag/no> <date> ... "ENTY" <u32 LE ×N>
```

Live parser output (abridged):

| Image | Flash tag | Chip ID | Size field | ENTY |
|---|---|---|---|---|
| Tanchjim DSP S 1.0.2 | `KT_lnv1b_flash_1` | `0211LC02` | 42,272 (= file) | `0x8b000` |
| TINHIFI KT02H20 1.0.1 | `KT_Helios_v1b___` | `KT02H20B` | 62,784 (= file) | `0x83000`, sz `0x1d188` |
| KT02F20 SDK ×2 | `KT_Helios_v1b___` | `KT02F20B` | 61,632 (= file) | `0x83000`, sz `0x1d188` |
| KT0206 boot 1.05 | `KT_msv2b_flash_` | `020xB04` | 45,160 (target image) | — |
| KT0712 SDK V2.1 | `KTM_TT_V3_flash_` | `KT0712A` | 160,400 (= file) | — |

Field notes:

- The tag↔chip-id boundary is a naming convention, not a delimiter —
  `KT_lnv1b_flash_1` + `0211LC02` concatenates with no separator; MSV2B adds
  an extra `_` before `020xB04`. Parse from the `"Size"` sentinel backwards.
- **ENTY load address = `0x83000`** on Helios SDK-class images; the Tanchjim
  production cut loads at `0x8b000`. The second ENTY word is the
  target-space size (includes erase-block padding — larger than the file).
- **File offset `0x3000` = load address `0x83000`.** The low `0x3000` bytes
  of the file are flasher metadata, never mapped — the boot tool strips them
  before writing. Base address of the raw image is `0x80000`.
- `0x1000–0x1140` carries build info (`REG:` defaults block marker, version,
  build date/time, git tag, `PerfCfg:`, product string); `0xc7b0–EOF` on
  JA11-class images is a printf-style debug-log string table.
- JA11-class header uses the same fields with magic spelled
  `KT_Helios_v1b\0\0\0`, chip id at `0x10`, `Size` at `0x18`, build hash at
  `0x20`, `ENTY` at `0x40` — the tag+`Size`-sentinel parse above is
  equivalent for all of them.

## 3. Chip internals relevant to hacking (KT02F20 datasheet V0.5, CN)

The vendor datasheet (hardware level — it does *not* document the USB HID
register protocol) confirms, at silicon level:

| Block | Fact |
|---|---|
| DSP | Upstream (mic) and downstream (each DAC) paths each carry a **5-band EQ** — matches the register map exactly |
| DRC | Separate `DRC_EN` enable + `DRC_TH<3:0>` compression-ratio nibble (hardware names for the §2 DRC registers) |
| Input PGA | Set via `ADC_FILT_CFG_0` (the register-level 0x3A index table) |
| Sidetone | `SIDETONE_L_VOL` / `SIDETONE_R_VOL`, 1 dB steps (marked TBD in V0.5) |
| Host volume | USB2DAC / ADC2USB volume driven by host UAC Feature Unit, **0.5 dB steps** |
| Headset | Auto OMTP/CTIA detection + adaptation, jack detect via GPIO level, mic-bias 1.2/2.8 V |
| Keys | Up to 4 configurable key inputs |
| GPIO | 6 pins, function-selected by `GPIOx_FUNC_SEL` (table below) |
| AUX ADC | 6-channel 8-bit SAR ADC (also the key/voltage-detect input path) |
| Flash | **2 Mbit (256 KB) internal**, customer-writable; internal bootloader |
| Package | QFN-36 4×4 mm, 0.35 mm pitch; dual DCDC + LDO, internal osc (no crystal) |

### GPIO function map — the hardware-access doorway

`GPIOx_FUNC_SEL` values (datasheet table 10 + pin descriptions):

| FUNC | GPIO0 | GPIO1 | GPIO2 | GPIO3 | GPIO4 | GPIO5 |
|---|---|---|---|---|---|---|
| 0 (default) | HighZ | HighZ | HighZ | HighZ | HighZ | HighZ |
| **1** | — | — | **UART_Rx** | **UART_Tx** | **SWD_CLK** | **SWD_DAT** |
| 2 | ADC CH0 | ADC CH1 | ADC CH2 | ADC CH3 | ADC CH4 | ADC CH5 |
| 3/4 | IN/OUT | IN/OUT | IN/OUT | IN/OUT | IN/OUT | IN/OUT |
| 5 | SDA | SCL | — | — | — | — |
| 8 | INT0 | INT1 | INT2 | INT3 | INT4 | INT5 |
| 9 | PWM | PWM | PWM | PWM | PWM | PWM |
| 10/11 | jack-detect variants (pull-up/down, active level) |

Consequences:

- **SWD lives on GPIO4 (CLK) / GPIO5 (DAT)** — on dongles that break these
  pins out (or with a test-pad probe), a hardware SWD attach gives the true
  firmware backup that the vendor toolchain deliberately denies you
  (`PROTOCOL.md` §7.7). This is the documented escape hatch for the
  "no software dump" dead end.
- **UART flash programming is first-class**: the internal bootloader
  consumes the flash over UART at power-on; vendor docs call for a
  USB-UART bridge (CP2103/PL2303 class) at **≥ 921600 baud** with the KTM
  host software, wired programmer-RxD→GPIO3 (TxD), programmer-TxD→GPIO2
  (RxD). The `KT_BOOT_TOOL` `comboBox_baund` values (115200/256000/576000/
  921600) are exactly this UART path — the serial half of the boot protocol
  in `PROTOCOL.md` §3 is spoken here.
- GPIO0/1 double as an I²C peripheral (`SDA`/`SCL`) — unused by the dongles
  but available to SDK builds.

## 4. Platform ↔ transport matrix (as of v10)

| Platform | Chips | CPU | Run-mode control | Boot transport | Flash tag |
|---|---|---|---|---|---|
| Helios v1b / lnv1b | KT0211L, KT02H20, KT02F20/21/22, KT02H22, KT0210(S), KT0231H | Andes NDS32 v3 | HID `0x4B` registers (`PROTOCOL.md` §1–2) | CDC serial `8888:cdc0` + HID feature (`31B2:0101/0001/0002`) | `KT_lnv1b_flash_1` / `KT_Helios_v1b` |
| MSV2B | KT0200, KT0201, KT0203N, KT0206, KT020X | — | **unknown** (no run-mode map; `kt_usb_cmd_tool -m` implies a HID side) | HID boot (`31B2:0020/0100` examples), `KT0206_boot_v1.05` RAM loader, `KTCInitKey`/`KTPrgKey` | `KT_msv2b_flash_1` |
| TT V3 | KT0712(A) | — | **unknown** (USB→I2S bridge family) | KT_BOOT_TOOL flasher (`KTM_TT_V3_flash_1`) | `KTM_TT_V3_flash_1` |

Roster names without any image or map yet: KT0211 (base part — presumably the
0211L die at a different SKU), KT70022, KT1200.

## 5. Reproduce / go further

```
python3 scripts/kt_img_header.py              # header table for any firmware dir
python3 scripts/kt_fw_analyze.py              # full section map per image
# Ghidra: import raw code bytes at load 0x83000 (file 0x3000), ISA NDS32:LE:32:default
# Toolchain: nds32le-elf-gcc (andestech/nds-gnu-toolchain) for build experiments
```

Open items live in `PROTOCOL.md` §7 (0x69 tail checksum, KT0231H volume
block, 0211L EN bit1). The 162 KB NDS32 loader blob is now *actionable*:
point Ghidra at it with the NDS32 backend — that is the ROM-side code that
consumes the `0x69` blocks, i.e. the most likely place the 4-byte block tail
is validated.
