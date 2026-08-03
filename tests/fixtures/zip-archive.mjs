import zlib from 'node:zlib';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UTF8_FILE_NAME_FLAG = 0x0800;

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = Array.from({ length: 256 }, (_, value) => {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1
        ? (current >>> 1) ^ 0xedb88320
        : current >>> 1;
    }
    return current >>> 0;
  });
  return crcTable;
}

export function crc32(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const table = getCrcTable();
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = (checksum >>> 8) ^ table[(checksum ^ byte) & 0xff];
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function uint16(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`zip_fixture_invalid_${field}`);
  }
  return value;
}

function uint32(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`zip_fixture_invalid_${field}`);
  }
  return value;
}

function bytes(value) {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value));
}

/**
 * Builds an actual ZIP32 byte sequence. Test callers may override redundant
 * header fields to produce hostile archives without mocking the reader.
 */
export function buildZip(entries, {
  archiveComment = '',
  endEntryCount = null
} = {}) {
  if (!Array.isArray(entries) || entries.length > 0xffff) {
    throw new Error('zip_fixture_invalid_entries');
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [index, input] of entries.entries()) {
    const data = bytes(input.data ?? Buffer.alloc(0));
    const method = input.method === 'store' || input.method === 0 ? 0 : 8;
    const compressed = input.compressedData
      ? bytes(input.compressedData)
      : method === 0
        ? data
        : zlib.deflateRawSync(data);
    const localName = bytes(input.localName ?? input.name);
    const centralName = bytes(input.centralName ?? input.name);
    const flags = uint16(input.flags ?? UTF8_FILE_NAME_FLAG, `flags_${index}`);
    const checksum = uint32(input.crc32 ?? crc32(data), `crc32_${index}`);
    const compressedSize = uint32(
      input.declaredCompressedSize ?? compressed.length,
      `compressed_size_${index}`
    );
    const uncompressedSize = uint32(
      input.declaredUncompressedSize ?? data.length,
      `uncompressed_size_${index}`
    );
    const localExtra = bytes(input.localExtra ?? Buffer.alloc(0));
    const centralExtra = bytes(input.centralExtra ?? Buffer.alloc(0));
    const fileComment = bytes(input.fileComment ?? Buffer.alloc(0));

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(uint16(localName.length, `local_name_${index}`), 26);
    localHeader.writeUInt16LE(uint16(localExtra.length, `local_extra_${index}`), 28);
    localParts.push(localHeader, localName, localExtra, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(uint16(centralName.length, `central_name_${index}`), 28);
    centralHeader.writeUInt16LE(uint16(centralExtra.length, `central_extra_${index}`), 30);
    centralHeader.writeUInt16LE(uint16(fileComment.length, `file_comment_${index}`), 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(input.externalAttributes ?? 0, 38);
    centralHeader.writeUInt32LE(uint32(input.localHeaderOffset ?? localOffset, `local_offset_${index}`), 42);
    centralParts.push(centralHeader, centralName, centralExtra, fileComment);

    localOffset += localHeader.length + localName.length + localExtra.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const comment = bytes(archiveComment);
  const entryCount = uint16(endEntryCount ?? entries.length, 'end_entry_count');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(uint32(centralDirectory.length, 'central_directory_size'), 12);
  end.writeUInt32LE(uint32(localOffset, 'central_directory_offset'), 16);
  end.writeUInt16LE(uint16(comment.length, 'archive_comment'), 20);

  return Buffer.concat([...localParts, centralDirectory, end, comment]);
}
