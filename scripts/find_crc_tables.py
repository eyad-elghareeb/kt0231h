#!/usr/bin/env python3
"""Search for CRC tables and polynomial constants in the EXEs."""
import pefile, struct, sys, binascii

CRC32_LE = 0xEDB88320
CRC32_BE = 0x04C11DB7
CRC32C_LE = 0x82F63B78
CRC32C_BE = 0x1EDC6F41

def crc32_table_le(poly):
    tbl = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ (poly & -(c & 1)) if c & 1 else c >> 1
        tbl.append(c)
    return tbl

def crc8_table(poly, init_lsb=True):
    tbl = []
    for i in range(256):
        c = i
        for _ in range(8):
            if init_lsb:
                c = ((c << 1) ^ poly) & 0xFF if c & 0x80 else (c << 1) & 0xFF
            else:
                c = ((c >> 1) ^ poly) if c & 1 else c >> 1
        tbl.append(c)
    return tbl

def find_all(pe, needle):
    hits = []
    for s in pe.sections:
        raw = s.get_data()
        i = raw.find(needle)
        while i != -1:
            hits.append((pe.OPTIONAL_HEADER.ImageBase + s.VirtualAddress + i,
                         s.Name.decode(errors='replace').rstrip('\x00')))
            i = raw.find(needle, i + 1)
    return hits

def scan(fn):
    pe = pefile.PE(fn, fast_load=True)
    print(f"===== {fn} =====")
    # CRC32 tables (first 8 entries LE)
    for name, poly in (("CRC32-LE-std", CRC32_LE), ("CRC32C-LE", CRC32C_LE),
                       ("CRC32-BE-normal", CRC32_BE), ("CRC32C-BE", CRC32C_BE)):
        if "BE" in name:
            tbl = []
            for i in range(256):
                c = i << 24
                for _ in range(8):
                    c = ((c << 1) ^ poly) & 0xFFFFFFFF if c & 0x80000000 else (c << 1) & 0xFFFFFFFF
                tbl.append(c)
        else:
            tbl = crc32_table_le(poly)
        sig = struct.pack("<8I", *tbl[:8])
        for va, sec in find_all(pe, sig):
            print(f"  {name} TABLE at {va:#x} ({sec})")
    # poly constants as imm32 in code
    for name, poly in (("0xEDB88320", CRC32_LE), ("0x04C11DB7", CRC32_BE),
                       ("0x82F63B78", CRC32C_LE), ("0x1EDC6F41", CRC32C_BE)):
        for va, sec in find_all(pe, struct.pack("<I", poly)):
            print(f"  const {name} at {va:#x} ({sec})")
    # crc8 tables poly 0x07/0x31/0x9B/0xD5 (msb-first)
    for poly in (0x07, 0x31, 0x9B, 0xD5, 0x1D, 0x2F):
        tbl = crc8_table(poly)
        sig = bytes(tbl[:8])
        for va, sec in find_all(pe, sig):
            # validate 256 entries
            raw = None
            for s in pe.sections:
                base = pe.OPTIONAL_HEADER.ImageBase + s.VirtualAddress
                if base <= va < base + s.Misc_VirtualSize:
                    off = va - base
                    raw = s.get_data()[off:off+256]
            if raw and bytes(crc8_table(poly)) == raw:
                print(f"  CRC8 table poly={poly:#04x} FULL at {va:#x} ({sec})")
            else:
                print(f"  CRC8 candidate poly={poly:#04x} partial at {va:#x} ({sec})")

scan(sys.argv[1])
