/**
 * FileDescriptorSet -> protobufjs-compatible JSON root.
 *
 * This is larkit's own parser.  It only reads descriptor bytes that the Feishu
 * client ships (pb.desc / pb_server.desc); it does not import any SDK code.
 */

const TYPE_MESSAGE = 11;
const TYPE_ENUM = 14;

const SCALAR = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  10: "group",
  11: "message",
  12: "bytes",
  13: "uint32",
  14: "enum",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
};

class Reader {
  constructor(input) {
    this.buf =
      input instanceof Uint8Array ? input : new Uint8Array(input);
    this.pos = 0;
  }

  get eof() {
    return this.pos >= this.buf.length;
  }

  readVarint() {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("varint too long");
    }
    throw new Error("truncated varint");
  }

  readTag() {
    if (this.eof) return null;
    const value = Number(this.readVarint());
    return { field: value >>> 3, wireType: value & 7 };
  }

  readBytes() {
    const length = Number(this.readVarint());
    if (length < 0 || this.pos + length > this.buf.length) {
      throw new Error("truncated length-delimited field");
    }
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readString() {
    return new TextDecoder().decode(this.readBytes());
  }

  skip(wireType) {
    if (wireType === 0) {
      this.readVarint();
    } else if (wireType === 1) {
      this.pos += 8;
    } else if (wireType === 2) {
      const length = Number(this.readVarint());
      this.pos += length;
    } else if (wireType === 5) {
      this.pos += 4;
    } else if (wireType === 3) {
      // group: skip until matching end-group
      while (!this.eof) {
        const tag = this.readTag();
        if (!tag) break;
        if (tag.wireType === 4) break;
        this.skip(tag.wireType);
      }
    } else if (wireType === 4) {
      // end-group marker; caller handles
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
    if (this.pos > this.buf.length) throw new Error("truncated field");
  }
}

function lowerCamel(name) {
  return String(name).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function parseFieldProto(bytes) {
  const reader = new Reader(bytes);
  const field = { name: "", number: 0, label: 0, type: 0 };
  let tag;
  while ((tag = reader.readTag()) !== null) {
    if (tag.field === 1 && tag.wireType === 2) field.name = reader.readString();
    else if (tag.field === 3 && tag.wireType === 0)
      field.number = Number(reader.readVarint());
    else if (tag.field === 4 && tag.wireType === 0)
      field.label = Number(reader.readVarint());
    else if (tag.field === 5 && tag.wireType === 0)
      field.type = Number(reader.readVarint());
    else if (tag.field === 6 && tag.wireType === 2)
      field.typeName = reader.readString();
    else if (tag.field === 7 && tag.wireType === 2)
      field.defaultValue = reader.readString();
    else if (tag.field === 8 && tag.wireType === 2) {
      const options = new Reader(reader.readBytes());
      let optionTag;
      while ((optionTag = options.readTag()) !== null) {
        if (optionTag.field === 1 && optionTag.wireType === 0) {
          field.packed = Number(options.readVarint()) === 1;
        } else {
          options.skip(optionTag.wireType);
        }
      }
    } else if (tag.field === 10 && tag.wireType === 2)
      field.jsonName = reader.readString();
    else reader.skip(tag.wireType);
  }
  return field;
}

function parseEnumProto(bytes) {
  const reader = new Reader(bytes);
  const out = { name: "", values: [] };
  let tag;
  while ((tag = reader.readTag()) !== null) {
    if (tag.field === 1 && tag.wireType === 2) {
      out.name = reader.readString();
    } else if (tag.field === 2 && tag.wireType === 2) {
      const valueReader = new Reader(reader.readBytes());
      let name;
      let number = 0;
      let valueTag;
      while ((valueTag = valueReader.readTag()) !== null) {
        if (valueTag.field === 1 && valueTag.wireType === 2) {
          name = valueReader.readString();
        } else if (valueTag.field === 2 && valueTag.wireType === 0) {
          number = Number(valueReader.readVarint());
        } else {
          valueReader.skip(valueTag.wireType);
        }
      }
      if (name) out.values.push({ name, number });
    } else {
      reader.skip(tag.wireType);
    }
  }
  return out;
}

function parseDescriptorProto(bytes) {
  const reader = new Reader(bytes);
  const out = {
    name: "",
    fields: [],
    nested: [],
    enums: [],
    mapEntry: false,
  };
  let tag;
  while ((tag = reader.readTag()) !== null) {
    if (tag.field === 1 && tag.wireType === 2) {
      out.name = reader.readString();
    } else if (tag.field === 2 && tag.wireType === 2) {
      out.fields.push(parseFieldProto(reader.readBytes()));
    } else if (tag.field === 3 && tag.wireType === 2) {
      out.nested.push(parseDescriptorProto(reader.readBytes()));
    } else if (tag.field === 4 && tag.wireType === 2) {
      out.enums.push(parseEnumProto(reader.readBytes()));
    } else if (tag.field === 7 && tag.wireType === 2) {
      const options = new Reader(reader.readBytes());
      let optionTag;
      while ((optionTag = options.readTag()) !== null) {
        if (optionTag.field === 7 && optionTag.wireType === 0) {
          out.mapEntry = Number(options.readVarint()) === 1;
        } else {
          options.skip(optionTag.wireType);
        }
      }
    } else {
      reader.skip(tag.wireType);
    }
  }
  return out;
}

function parseFileDescriptorProto(bytes) {
  const reader = new Reader(bytes);
  const file = { name: "", package: "", messages: [], enums: [] };
  let tag;
  while ((tag = reader.readTag()) !== null) {
    if (tag.field === 1 && tag.wireType === 2) file.name = reader.readString();
    else if (tag.field === 2 && tag.wireType === 2)
      file.package = reader.readString();
    else if (tag.field === 3 && tag.wireType === 2) reader.readString();
    else if (tag.field === 4 && tag.wireType === 2)
      file.messages.push(parseDescriptorProto(reader.readBytes()));
    else if (tag.field === 5 && tag.wireType === 2)
      file.enums.push(parseEnumProto(reader.readBytes()));
    else reader.skip(tag.wireType);
  }
  return file;
}

function fieldTypeName(field) {
  if (field.type === TYPE_MESSAGE || field.type === TYPE_ENUM) {
    return (field.typeName || "").replace(/^\./, "") || "bytes";
  }
  return SCALAR[field.type] || "bytes";
}

function attach(root, fq, definition) {
  const parts = fq.split(".").filter(Boolean);
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const nested = node.nested || (node.nested = {});
    const child = nested[key];
    if (child && typeof child === "object" && "nested" in child) {
      node = child;
    } else if (child && typeof child === "object") {
      child.nested = child.nested || {};
      node = child;
    } else {
      const next = { nested: {} };
      nested[key] = next;
      node = next;
    }
  }
  const last = parts[parts.length - 1];
  const nested = node.nested || (node.nested = {});
  nested[last] = definition;
}

function collectMessage(root, scope, descriptor) {
  if (descriptor.mapEntry) return;
  const fq = scope ? `${scope}.${descriptor.name}` : descriptor.name;
  const node = { fields: {} };
  attach(root, fq, node);

  for (const field of descriptor.fields) {
    const key = field.jsonName || lowerCamel(field.name);
    const def = { type: fieldTypeName(field), id: field.number };
    if (field.label === 3) def.rule = "repeated";
    else if (field.label === 2) def.rule = "required";
    if (field.packed || field.defaultValue !== undefined) {
      def.options = {};
      if (field.packed) def.options.packed = true;
      if (field.defaultValue !== undefined)
        def.options.default = field.defaultValue;
    }
    node.fields[key] = def;
  }

  // Map entries are represented as nested messages whose parent field points
  // at the entry type.  Convert them to protobufjs map fields (keyType/type).
  for (const sub of descriptor.nested) {
    if (!sub.mapEntry) continue;
    const keyField = sub.fields.find((field) => field.number === 1);
    const valueField = sub.fields.find((field) => field.number === 2);
    if (!keyField || !valueField) continue;
    const entryFq = `${fq}.${sub.name}`;
    for (const field of descriptor.fields) {
      const raw = (field.typeName || "").replace(/^\./, "");
      if (raw !== entryFq) continue;
      const key = field.jsonName || lowerCamel(field.name);
      node.fields[key] = {
        keyType: fieldTypeName(keyField),
        type: fieldTypeName(valueField),
        id: field.number,
      };
    }
  }

  for (const sub of descriptor.nested) {
    if (!sub.mapEntry) collectMessage(root, fq, sub);
  }
  for (const enumDescriptor of descriptor.enums) {
    const values = {};
    for (const value of enumDescriptor.values) {
      values[value.name] = value.number;
    }
    attach(root, `${fq}.${enumDescriptor.name}`, { values });
  }
}

export function parseFileDescriptorSet(input) {
  const reader = new Reader(input);
  const root = { nested: {} };
  let tag;
  while ((tag = reader.readTag()) !== null) {
    if (tag.field === 1 && tag.wireType === 2) {
      const file = parseFileDescriptorProto(reader.readBytes());
      for (const message of file.messages) {
        collectMessage(root, file.package, message);
      }
      for (const enumDescriptor of file.enums) {
        const values = {};
        for (const value of enumDescriptor.values) {
          values[value.name] = value.number;
        }
        attach(
          root,
          file.package
            ? `${file.package}.${enumDescriptor.name}`
            : enumDescriptor.name,
          { values },
        );
      }
    } else {
      reader.skip(tag.wireType);
    }
  }
  return root;
}

export function mergeRoots(...roots) {
  const out = { nested: {} };
  for (const root of roots) mergeInto(out, root);
  return out;
}

function mergeInto(target, source) {
  const targetNested = target.nested || (target.nested = {});
  const sourceNested = source?.nested || {};
  for (const [key, value] of Object.entries(sourceNested)) {
    const existing = targetNested[key];
    if (
      existing &&
      typeof existing === "object" &&
      typeof value === "object" &&
      "nested" in existing &&
      "nested" in value
    ) {
      mergeInto(existing, value);
    } else {
      targetNested[key] = value;
    }
  }
}
