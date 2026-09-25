# KTMicro Vendor Tools — Inventory, Sources & Disassembly Findings

The chip vendor is **昆腾微电子 (Quantum Micro Electronics, ktmicro.com,
Beijing)** — tools are OEM-distributed, not on their website. This repo now
documents every tool binary we could recover, where it came from, what's
inside, and what it settled. Binary hashes let you verify anything you obtain
independently.

## 1. Tool inventory (all i386, statically-linked Qt)

| Tool | Size | SHA-256 (first 16) | Link time | Source |
|---|---|---|---|---|
| `KT_USB_APP.exe` (EQ tuning app) | 22,282,752 B | `20a44e78705c24b3` | 2024-01-02 | `https://image.lceda.cn/oshwhub/project/attachments/abd1556a453f4bd9b2ab419a47526bc2.zip` (oshwhub KT02F20 project, includes `writechip/` + vendor logs) |
| `KT_BOOT_TOOL_1.0.58.exe` (bootloader flasher) | 23,708,160 B | `faca3c5554eea22f` | 2024-04-30 | same package, `writechip/` subdir |
| `KT Upgrade Tool.exe` (boot UI "KT_USB_BOOT_UI 021X 0211L 02H0X 02F0X 1.2.10") | 20,802,560 B | `68c1449e9c5757d8` | 2024-07-26 | `https://image.lceda.cn/oshwhub/project/attachments/14df6694c27a4961aee5dfb4a32276dc.zip` |
| `kt_usb_cmd_tool.exe` v1.3.16 (CLI; carved) | 5,836,432 B | — | — | carved at PE offset `0x5570` of `TANCHJIM_DSPS_BOOT_TOOL_1.0.03.exe` (6,153,728 B, `cd708f8110000e32`, 2024-09-13) from the official Tanchjim DSP S upgrade zip |
| `KT_VCP_V1.0.0_Setup.exe` (VCP/CDC driver) | 928,943 B | — | — | standalone in the Tanchjim zip; also embedded in KT_BOOT_TOOL resources and shipped as `ktRES/driver.exe` |
| `TANCHJIM_DSPS固件升级说明.docx` | — | — | — | official Chinese upgrade steps (loads the BIN in the boot tool, click upgrade; needs KT_VCP driver on Win7) |

Not recovered (yet): any newer `KT_USB_APP` than 1.0.17; the update channel
KT_BOOT_TOOL phones home to is `http://101.42.35.97/KT_WORK/KT_BOOT_TOOL/KT_BOOT_TOOL.xml`
(China-only, dead from outside).

## 2. What the disassembly settled (new vs. upstream PROTOCOL.md)

1. **Vendor chip roster** (KT_BOOT_TOOL comboBox construction, `.text`
   `~0x1218d40`): `KT0200, KT0201, KT0203N, KT0206, KT0210, KT0211, KT0211L,
   KT0210S, KT0231H, KT02H20, KT02H22, KT02F20, KT02F21, KT02F22, KT70022,
   KT1200, KT0712` — in that order. KT0210 (Bunny) and the 02F2x family are
   officially supported by the same flasher.
2. **Boot-mode PID `31B2:0001` is real**: the embedded KT0206 boot image
   carries a USB device descriptor with exactly that VID:PID — the boot
   panel's `PIDS: [0x0101, 0x0001, 0x0002]` triple is validated, not guessed.
3. **MSV2B boot loader keys**: `KTCInitKey` / `KTPrgKey` strings inside
   `KT0206_boot_v1.05_20210608.bin` (now in `firmware/`) — the KEY unlock
   handshake on that family is materialized from these constants. First public
   extraction of the actual MSV2B RAM-loader payload.
4. **KT0712 firmware recovered**: KT_BOOT_TOOL embeds a full
   `KTM_TT_V3_flash_KT0712A` SDK image (160,400 B, "KT0712_SDK_V2.1",
   "BYD-mic+div5", build `Jul 24 2023 16:24:56`, tag `d2d2f55`, ENTY
   `0x001960f0`) plus the `KT0712_reset_spi` loader pieces. Upstream only knew
   the flash name from `.rdata`; now we have the image itself.
5. **`KT Upgrade Tool 1.2.10`** (new tool, no public docs): same Qt/i386 shape,
   `.rdata` carries the Helios/021x boot UI strings; its INI keys
   (`CustomVID/HomeVID/IsInfAck/Repeat/AutoFile/TestShow`) match the old boot
   tool's `ktRES/info.ini` schema, so it is a UI refresh over the same boot
   protocol, explicitly scoped by its own INI name to `021X 0211L 02H0X 02F0X`
   — i.e. **no KT0231H in its supported list**; KT0231H units still use
   KT_BOOT_TOOL's comboBox entry 8.
6. **No dump/read primitive anywhere** (re-confirms upstream §7.7): the full
   verb list of `kt_usb_cmd_tool` (`-b/-pb/-v/-pl/-t/-bv`, hidden `-fb/-nb`),
   the write-only vendor logs, and the bootloader token inventory all remain
   read-less. Hardware backup stays mandatory.
7. **Vendor log corpus**: the 20 `writechip/Log/*.txt` hex logs (2023-10/12)
   ship with the KT_USB_APP package — they are the same logs upstream's
   `reconstruct_fw.py` was built against; the 42,640-byte KT0211L vendor image
   they contain reconstructs byte-identically.

## 3. Qt resource map (carved from KT_BOOT_TOOL_1.0.58.exe)

RCC data array walked via `[u32 BE total][payload]` entries
(`scripts/kt_rcc_walk2.py`, anchors: `devcon.exe` raw @ `0xfa1bd4`):

| Resource | File offset | Bytes | Identity |
|---|---|---|---|
| `devcon.exe` (32-bit) | `0xfa1bd4` | 90,576 | raw PE (VeriSign-signed, 2006) |
| `devcon_64.exe` | `0xfb7da8` | 77,776 raw (23,189 compressed) | zlib entry `[u32 unc][stream]` |
| **KT0712 SDK firmware** | `0xfbd841` | 160,400 | `KTM_TT_V3_flash_KT0712A…` → `firmware/KT0712_SDK_V2.1_20230724.bin` |
| **KT0712_reset_spi pieces** | `0xfe4ad5`, `0xfe4bb9` | 224 + 32 | NDS32 loader stubs |
| ram loader blob | `0xfe4bdd` | 162,307 | NDS32 code (no ASCII); likely the lnv1b-family `ram_flashload.bin` payload — **unresolved, see below** |
| `devcon.bat` | `0x100c5e4` | 825 | plain text |
| `KT_VCP_V1.0.0_Setup.exe` | `0x100c921` | 928,943 | raw PE (`MZP` DOS-stub) |
| `tubiao.png` | `0x10ef5d4` | 14,242 | PNG |

Open: the `0x69` 1024-B-block tail checksum (upstream §7.1) is *probably*
settleable from the 162,307-B NDS32 blob — it is the only loader we haven't
disassembled (no strings, needs an NDS32 disassembler; the MSV2B analogue in
the Tanchjim tool is fully stringed). Anyone with capstone NDS32 support:
that blob is the target.

## 4. kt_usb_cmd_tool v1.3.16 — CLI surface (verified from the carve)

```
arg1 transport:  -m  HID (KT020X)          -s  serial (KT021X/KT02H2X/KT02F2X)
arg2 operation:  -b boot   -pb boot-by-path   -v version
                 -pl path-list   -t to-CDC   -bv boot-version   (hidden: -fb -nb)
arg3/4: VID PID        arg5: <image>.bin
```
Default boot image `KT0206_boot_v1.05_20210608.bin`, flash tag
`KT_msv2b_flash_1`, log `/Log/log.txt`, steps logged as `STEP_ShakeHand`,
`turn to cdc`. Example VID:PID `0x31b2 0x0020`; HID path template
`vid_352f&pid_0100&mi_03`. **No dump flag exists** — `-v` reads the version,
everything else writes.

## 5. Sourcing the big EXEs

Both oshwhub attachments are public and stable:
- KT_USB_APP.zip → `https://image.lceda.cn/oshwhub/project/attachments/abd1556a453f4bd9b2ab419a47526bc2.zip`
- KT Upgrade Tool.zip → `https://image.lceda.cn/oshwhub/project/attachments/14df6694c27a4961aee5dfb4a32276dc.zip`
- KT02F20 datasheet V0.5 (CN) → `https://image.lceda.cn/oshwhub/project/attachments/e4cf6d25fe38493baa65989844f89528.pdf`
- Tanchjim DSP S upgrade zip → `https://d1c6gk3tn6ydje.cloudfront.net/1875933634511282176%2Fde3560213f76846d44d7a10d2398a9da.zip` (also linked from `tanchjim.com/en/dsps-upgrade/`)

`ktmicro.com` (昆腾微) publishes product pages for KT0231H/KT02H20/KT0211L/
KT0206/KT0210 but has **no download section**; tools/datasheets come via
`support@ktmicro.com` or the OEM channel. There is no Tangzu-branded app or
tool anywhere — Tangzu ships the Wan'er 2 DSP without software.

## 2b. v11 finding — KT_BOOT_TOOL contains a scoped flash-read path

Context-string reconstruction around the flash verb block (see
`PROTOCOL.md` §10.1, scan with `scripts/kt_boot_tokens.py`):

```
flash_cancel :hid · flash_read_crc :hid / :crc8 / :crc32
flash_read_all (×3) · KTM_TT_V3_flash · default · ./test.bin
spi flash  · BootInterface  · KTSPI (menu) · checkBox_ktspi_test
```

- `flash_read_all` writes its output to **`./test.bin`** and belongs to the
  KTSPI / KT0712 external-SPI-bridge flow (`KTM_TT_V3_flash` + reset-spi
  loaders in the same block) — it is **absent** from `KT Upgrade Tool
  1.2.10` and the carved `kt_usb_cmd_tool` 1.3.16.
- `flash_read_crc` (crc8 + crc32) = verify-after-write readback of written
  blocks, not a dump primitive.
- Net effect on the "no dump" doctrine: Helios internal flash still has no
  software read path anywhere in the vendor toolset; KT0712-class devices
  with external SPI flash are the one family the vendor tool itself can
  likely dump. See `HARDWARE-DUMP.md`.
