# DAC Control - KT0231H / KT0211L / KT02H20

Browser-based parametric EQ controller for **KTMicro** USB audio DSP dongles/cables.
Goal: fully working on all three chips — **KT0231H**, **KT0211L**, **KT02H20**.

Forked from https://github.com/gxcreator/kt02h20-control. Protocol description:
https://github.com/gxcreator/ktmicro-tools/tree/master

## Support matrix

| Chip | VID:PID | DAC EQ | Write ACK | Map status |
|------|---------|--------|-----------|------------|
| KT0231H | `0x31B2:0x1132` | 6 bands @ `0x35–0x40`, EN @ `0x34` | `0x4F` | Hardware-verified (dump + write/readback/restore, 2026-09-21) |
| KT0211L | `0x31B2:0x0111` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` | Hardware-verified (full dump + write ACK, 2026-09-21; seen as `CDS.KT USB Audio`, FW `CDSV100.003`) |
| KT02H20 | `0x31B2:0x0111` | 5 bands @ `0x26–0x2F`, EN @ `0x24` | `0x03` | From upstream repo, **no hardware on hand — untested in this fork** |

KT0211L and KT02H20 share a VID:PID, so the app picks the profile by product
name first (`CDS…`/`0211…` → KT0211L, `KT02H20…`/`JM12…` → KT02H20) and falls
back to VID:PID (a name-wiped `0x0111` device lands on KT02H20, which is
register-identical for DAC EQ).

## Quick start

1. Open the `index.html` Web UI in Chrome or Edge desktop (WebHID isn't supported in Firefox/Safari).
2. Click "Connect USB", select the KT USB device (profile is shown in the header after connect).
3. Read/write the DAC EQ, toggle EQ on/off, adjust digital DAC gain.

> Linux: needs a udev rule for `/dev/hidraw*` access. If `device.open()` throws `NotAllowedError`, add:
> ```
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="1132", TAG+="uaccess"
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="0111", TAG+="uaccess"
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
| 65 | 0x41 | Second-bank (ADC side) EQ enable (= 1) |
| 66–77 | 0x42–0x4D | Second-bank bands #0–#5, same defaults |

## Known shortcomings (honest list, 2026-09-22)

1. **No persistence on any chip (biggest gap).** HID register writes go to DSP
   RAM only — unplug/replug wipes everything. Reverse-engineering (static
   disassembly of the vendor `KT_USB_APP.exe`: HID layer is `WriteFile`/
   `ReadFile` only, no `HidD`/feature reports, no hidden save command found;
   vendor's own docs) shows the official persist flow is **Save-BIN +
   reflash with `KT_BOOT_TOOL`**, not a run-mode command. Persist image
   layout (from `JA11_V2.2` vs `JA11_V2.2_Ellyn` diff): DAC table at BIN
   `0x106A` (5×8 bytes `[freq u16][Q u16][gain s16][type u16]`), ADC table at
   `0x109A`. ⚠️ Never flash a foreign BIN (e.g. JA11 image onto a KT0211L
   unit) — a persist-flash must patch the unit's *own* firmware backup.
2. **KT0231H volume regs unknown.** `0x3A/0x3B` are EQ regs on this chip (not
   PGA) and `0x65/0x66` read zero — volume controls are best-effort and may
   do nothing. The second (ADC-side) bank is not exposed in the UI yet.
3. **KT0211L/KT02H20 EQ-enable reads `3`, not `1`.** Bit1 meaning unknown; the
   app sets/clears bit0 only and preserves the rest.
4. **KT02H20 never tested on hardware here** — profile kept from upstream.
5. **The `0x43` handshake must not be sent** (stalls the KT0231H HID pipe);
   reads/writes work without it.
6. Vendor `KT_USB_APP` could not see the test dongle in its device list
   (only KB/mice), so vendor-SYNC behavior is unverified — and its device
   list, not ours, is the suspect there (our HID access works fine).
