const varuint = require('varuint-bitcoin')

class BufferWrap {
  constructor (buffer, offset = 0) {
    this.buffer = buffer
    this.offset = offset
  }

  rest () {
    return this.buffer.slice(this.offset)
  }

  isEof () {
    return this.offset >= this.buffer.length
  }

  read (n) {
    this.offset += n
    return this.buffer.slice(this.offset - n, this.offset)
  }

  readUInt32 () {
    const i = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return i
  }

  readInt32 () {
    const i = this.buffer.readInt32LE(this.offset)
    this.offset += 4
    return i
  }

  readVarInt () {
    const vi = varuint.decode(this.buffer, this.offset)
    this.offset += varuint.decode.bytes
    return vi
  }

  readObject (type, ...args) {
    const inst = type.fromBuffer(this.rest(), ...args)
    this.offset += inst.byteLength()
    return inst
  }

  readList (fn) {
    const n = this.readVarInt()
    const list = new Array(n)
    for (let i = 0; i < n; i++) {
      list[i] = fn(this)
    }
    return list
  }

  write (src, start, end) {
    this.offset += src.copy(this.buffer, this.offset, start, end)
  }

  writeUInt32 (i) {
    this.buffer.writeUInt32LE(i, this.offset)
    this.offset += 4
  }

  writeInt32 (i) {
    this.buffer.writeInt32LE(i, this.offset)
    this.offset += 4
  }

  writeVarInt (vi) {
    varuint.encode(vi, this.buffer, this.offset)
    this.offset += varuint.encode.bytes
  }

  writeObject (obj, ...args) {
    this.write(obj.toBuffer(...args))
  }

  writeList (list, fn) {
    const n = list.length
    this.writeVarInt(n)
    for (let i = 0; i < n; i++) {
      fn(this, list[i])
    }
  }
}

module.exports = BufferWrap
