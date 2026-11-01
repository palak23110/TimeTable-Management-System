'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attribute(xml, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`(?:^|\\s)${escapedName}="([^"]*)"`));
  return match ? decodeXml(match[1]) : '';
}

function zipEntries(buffer) {
  let endOffset = -1;
  const searchStart = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('The workbook is not a valid ZIP-based .xlsx file.');

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('The workbook ZIP directory is invalid.');
    }
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('The workbook ZIP entry is invalid.');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return compressed.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(compressed).toString('utf8');
  throw new Error(`Unsupported workbook ZIP compression method ${entry.method}.`);
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return -1;
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function textNodes(xml) {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((match) => decodeXml(match[1]))
    .join('');
}

function readCell(xml, sharedStrings) {
  const type = attribute(xml, 't');
  if (type === 'inlineStr') {
    const inline = xml.match(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/);
    return inline ? textNodes(inline[1]) : '';
  }
  const value = xml.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? '';
  if (type === 's') return sharedStrings[Number(value)] ?? '';
  if (type === 'b') return value === '1';
  return decodeXml(value);
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r')) || rows.length + 1;
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const reference = attribute(cellMatch[1], 'r');
      const index = columnIndex(reference);
      if (index < 0) continue;
      cells[index] = readCell(cellMatch[0], sharedStrings);
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

function readWorkbook(filePath) {
  const buffer = fs.readFileSync(filePath);
  const entries = zipEntries(buffer);
  const read = (name) => {
    const entry = entries.get(name);
    return entry ? extractEntry(buffer, entry) : null;
  };
  const workbookXml = read('xl/workbook.xml');
  const relationshipsXml = read('xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relationshipsXml) throw new Error('The file is missing required workbook metadata.');

  const relationships = new Map();
  for (const match of relationshipsXml.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)(?:\/>|>[^<]*<\/(?:\w+:)?Relationship>)/g)) {
    relationships.set(attribute(match[1], 'Id'), attribute(match[1], 'Target'));
  }
  const sharedStringsXml = read('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml
    ? [...sharedStringsXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)]
      .map((match) => textNodes(match[1]))
    : [];
  const sheets = [];
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)(?:\/>|>[^<]*<\/(?:\w+:)?sheet>)/g)) {
    const name = attribute(match[1], 'name');
    const relationshipId = attribute(match[1], 'r:id');
    const target = relationships.get(relationshipId);
    if (!name || !target) throw new Error('A worksheet is missing its workbook relationship.');
    const entryName = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = read(entryName);
    if (!xml) throw new Error(`Worksheet '${name}' could not be read from the workbook.`);
    sheets.push({ name, rows: parseWorksheet(xml, sharedStrings) });
  }
  return sheets;
}

module.exports = { readWorkbook };
