# DAC Control - KT0231H (+ KT02H20 compat)

Browser-based parametric EQ controller for **KTMicro KT0231H** USB audio DSP dongles/cables
(VID:PID `0x31B2:0x1132`), with fallback support for **KT02H20** (`0x31B2:0x0111`, e.g. JCALLY JM12).

Forked from https://github.com/gxcreator/kt02h20-control and re-targeted at the KT0231H
register map published by CedarX in
[ASR post #560](https://www.audiosciencereview.com/forum/index.php?posts/2456286/)
(FiiO JA11 thread, Nov 2025 — KZ cable with KT0231H, PID `1132`).

Protocol description: https://github.com/gxcreator/ktmicro-tools/tree/master

## Quick start

1. Open the `index.html` Web UI in Chrome or Edge desktop (WebHID isn't supported in Firefox/Safari).
2. Click "Connect USB", select the KT USB device (profile is picked by VID:PID first, product-name second).
3. Read/write the DAC EQ (KT0231H: 6 bands, KT02H20: 5 bands), toggle EQ on/off, adjust digital DAC gain.

> Linux: needs a udev rule for `/dev/hidraw*` access. If `device.open()` throws `NotAllowedError`, add:
> ```
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="1132", TAG+="uaccess"
> SUBSYSTEM=="hidraw", ATTRS{idVendor}=="31b2", ATTRS{idProduct}=="0111", TAG+="uaccess"
> ```
> to `/etc/udev/rules.d/99-kt0231h.rules`, then `sudo udevadm control --reload && sudo udevadm trigger`.

## KT0231H register map (from the ASR post)

Same HID protocol as KT02H20 (`0x4B` report, `0x52` read / `0x57` write) and same
per-band A/B encoding:

- A_reg = `[freq_Hz:16][gain×10:16 signed]`, B_reg = `[type][Q×1000]`
- Filter types: 0 Peak, 1 LPF, 2 HPF, 3 Low-Shelf, 4 High-Shelf

| Dec | Hex  | Default dec | Default hex  | Content            |
|-----|------|-------------|--------------|--------------------|
| 53  | 0x35 | 3997696     | 0x003D0000   | DAC #0 Freq & Gain (61 Hz, 0 dB) |
| 54  | 0x36 | 700         | 0x000002BC   | DAC #0 Type & Q (Peak, 0.700) |
| 55  | 0x37 | 7995392     | 0x007A0000   | DAC #1 (122 Hz) |
| 56  | 0x38 | 700         | 0x000002BC   | DAC #1 Type & Q |
| 57  | 0x39 | 12058624    | 0x00B80000   | DAC #2 (184 Hz) |
| 58  | 0x3A | 700         | 0x000002BC   | DAC #2 Type & Q |
| 59  | 0x3B | 16252928    | 0x00F80000   | DAC #3 (248 Hz) |
| 60  | 0x3C | 700         | 0x000002BC   | DAC #3 Type & Q |
| 61  | 0x3D | 20709376    | 0x013C0000   | DAC #4 (316 Hz) |
| 62  | 0x3E | 700         | 0x000002BC   | DAC #4 Type & Q |
| 63  | 0x3F | 25690112    | 0x01880000   | DAC #5 (392 Hz) |
| 64  | 0x40 | 700         | 0x000002BC   | DAC #5 Type & Q |

Example from the post: 200 Hz / +6 dB / Q 0.7 low-shelf on filter #0 =
write `0x00C8003C` to `0x35`, `0x000302BC` to `0x36`.

## Verified on hardware (0x31B2:0x1132, 2026-09-21)

Live HID probing (reads + distinct-value write/readback/restore) confirmed and
corrected the map above:

- **Writes succeed with status `0x4F`, not `0x03`.** The old code treated every
  write as failed (`ACK=79`) while the value was actually stored. The app now
  accepts `0x4F` as the KT0231H write-ACK (per-profile `writeAck`).
- **EQ-enable is `0x34`** (= base−1), currently `1`. The earlier `0x33` guess was wrong.
- **Second 6-band bank at `0x42–0x4D`, enable at `0x41`** (= 1), same factory defaults
  (ADC side; not yet exposed in the UI).
- Version string at `0x06` (reads e.g. `0.0.1…`), VID:PID at `0x1B`, serial at
  `0x24–0x2A`, product string at `0x2C–0x30`, MAGIC `0x12345678` at `0x60`.
- The `0x43` handshake is NOT required (and stalls the HID pipe on this chip) —
  reads/writes work without it.

Still unknown: volume regs. `0x3A/0x3B` are EQ band regs here (not PGA), and
`0x65/0x66` read `0x00000000`. PGA/DIG addresses from KT02H20 are kept as
best-effort reads only, so a wrong address logs a warning instead of breaking
the EQ workflow.
