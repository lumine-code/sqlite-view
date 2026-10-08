"use strict";

const { Buffer } = require("node:buffer");
const { decodeScalar, encodeScalar } = require("../lib/sqlite/values");

describe("SQLite scalar BLOB bytes", () => {
  const viewTypes = [
    DataView,
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  ];

  for (const View of viewTypes) {
    it(`round-trips the exact offset byte slice of ${View.name}`, () => {
      const storage = new ArrayBuffer(64);
      const bytes = new Uint8Array(storage);
      bytes.forEach((_, index) => {
        bytes[index] = (index * 17 + 3) % 256;
      });
      const offset = View.BYTES_PER_ELEMENT ?? 3;
      const view = new View(storage, offset, View === DataView ? 11 : 3);
      const expected = Buffer.from(bytes.subarray(offset, offset + view.byteLength));
      for (const type of [null, "blob"]) {
        const encoded = JSON.parse(JSON.stringify(encodeScalar(view, type)));
        expect(encoded).toEqual(["b", expected.toString("base64")]);
        expect(decodeScalar(encoded).equals(expected)).toBe(true);
      }
    });
  }

  it("preserves ordinary Buffer slices without including surrounding pooled bytes", () => {
    const storage = Buffer.from([255, 17, 34, 51, 254]);
    const value = storage.subarray(1, 4);
    const encoded = JSON.parse(JSON.stringify(encodeScalar(value)));
    expect(encoded).toEqual(["b", "ESIz"]);
    expect(decodeScalar(encoded).equals(value)).toBe(true);
  });

  it("encodes empty offset views as empty BLOBs", () => {
    const storage = new ArrayBuffer(16);
    for (const value of [new DataView(storage, 3, 0), new Uint16Array(storage, 2, 0)]) {
      expect(encodeScalar(value)).toEqual(["b", ""]);
      expect(decodeScalar(encodeScalar(value)).length).toBe(0);
    }
  });

  it("retains the explicit BLOB fallback for non-view byte inputs", () => {
    expect(encodeScalar([17, 34, 51], "blob")).toEqual(["b", "ESIz"]);
    expect(encodeScalar(Uint8Array.from([17, 34, 51]).buffer, "blob")).toEqual(["b", "ESIz"]);
  });

  if (typeof SharedArrayBuffer === "function") {
    it("round-trips exact slices of SharedArrayBuffer-backed views", () => {
      const storage = new SharedArrayBuffer(16);
      const bytes = new Uint8Array(storage);
      bytes.set([255, 17, 34, 51, 68, 85, 102, 254]);
      for (const view of [new DataView(storage, 1, 6), new Uint16Array(storage, 2, 3)]) {
        const expected = Buffer.from(
          bytes.subarray(view.byteOffset, view.byteOffset + view.byteLength),
        );
        expect(decodeScalar(encodeScalar(view)).equals(expected)).toBe(true);
      }
    });
  }
});
