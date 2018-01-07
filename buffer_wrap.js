const varuint = require('varuint-bitcoin')

class BufferWrap {
  constructor (buffer) {
    this.buffer = buffer
    this.offset = 0
  }

  rest () {
    return this.buffer.slice(this.offset)
  }

  isEof () {
    return this.offset >= this.buffer.length
  }

  readSlice (n) {
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

  readType (type, ...args) {
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
}

module.exports = BufferWrap
