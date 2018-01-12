const { Block, Transaction, crypto: bcrypto } = require('bitcoinjs-lib')
const varuint = require('varuint-bitcoin')
const reverse = require('buffer-reverse')
const crypto = require('crypto')
const BufferWrap = require('./buffer_wrap')
const binding = require('./build/Release/binding.node')

const mergedMiningHeader = Buffer.from([0xfa, 0xbe, 0x6d, 0x6d])

const sha1 = (buf1, buf2) => {
  return crypto.createHash('sha1')
    .update(buf1)
    .update(buf2)
    .digest()
}

const getExpectedIndex = (nonce, chainId, h) => {
  // Choose a pseudo-random slot in the chain merkle tree
  // but have it be fixed for a size/nonce/chain combination.
  //
  // This prevents the same work from being used twice for the
  // same chain while reducing the chance that two chains clash
  // for the same slot.

  let rand = nonce
  rand = rand * 1103515245 + 12345
  rand += chainId
  rand = rand * 1103515245 + 12345

  return rand % (1 << h)
}

class MerkleBranch {
  constructor () {
    this.hashes = null
    this.sideMask = 0
  }

  static fromBuffer (buf) {
    return AuxPoW.fromBufferWrap(new BufferWrap(buf))
  }

  static fromBufferWrap (w) {
    const b = new MerkleBranch()
    b.hashes = w.readList((w) => w.read(32))
    b.sideMask = w.readInt32()
    return b
  }

  byteLength () {
    return 4 + varuint.encodingLength(this.hashes.length) +
      this.hashes.length * 32
  }

  toBuffer () {
    const buffer = Buffer.alloc(this.byteLength())
    this.toBufferWrap(new BufferWrap(buffer))
    return buffer
  }

  toBufferWrap (w) {
    w.writeList(this.hashes, (w, hash) => w.write(hash))
    w.writeInt32(this.sideMask)
  }

  getHash (hash) {
    let m = this.sideMask
    if (m === -1) return null
    for (const node of this.hashes) {
      if (m & 1) {
        hash = sha1(node, hash)
      } else {
        hash = sha1(hash, node)
      }
      m = m >> 1
    }
    return hash
  }
}

class AuxPoW {
  constructor () {
    this.coinbaseTx = null
    this.blockHash = null
    this.coinbaseBranch = null
    this.blockchainBranch = null
    this.parentBlock = null
  }

  static fromBuffer (buf) {
    return AuxPoW.fromBufferWrap(new BufferWrap(buf))
  }

  static fromBufferWrap (w) {
    const a = new AuxPoW()
    a.tx = w.readObject(Transaction, true)
    a.blockHash = w.read(32)
    a.coinbaseBranch = MerkleBranch.fromBufferWrap(w)
    a.blockchainBranch = MerkleBranch.fromBufferWrap(w)
    a.parentBlock = DogeBlock.fromBufferWrap(w, 0)
    return a
  }

  byteLength () {
    return 112 + this.tx.byteLength() +
      this.coinbaseBranch.byteLength() + this.blockchainBranch.byteLength()
  }

  toBuffer () {
    const buffer = Buffer.alloc(this.byteLength())
    this.toBufferWrap(new BufferWrap(buffer))
    return buffer
  }

  toBufferWrap (w) {
    w.writeObject(this.tx)
    w.write(this.blockHash)
    this.coinbaseBranch.toBufferWrap(w)
    this.blockchainBranch.toBufferWrap(w)
    this.parentBlock.toBufferWrap(w, 0)
  }

  check (auxBlockHash, chainId) {
    if (this.coinbaseBranch.sideMask === 0) {
      throw Error('AuxPoW is not a generate')
    }
    if (this.getChainId() === this.parentBlock.getChainId()) {
      throw Error('AuxPoW parent has our chain ID')
    }
    if (this.blockchainBranch.hashes.length > 30) {
      throw Error('AuxPoW chain merkle branch too long')
    }

    const { script } = this.tx.ins[0]

    // Check that the chain merkle root is in the coinbase
    const rootHash = this.blockchainBranch.getHash(auxBlockHash)
    let pc = script.indexOf(rootHash)
    if (pc === -1) {
      throw Error('AuxPoW missing chain merkle root in parent coinbase')
    }

    // Check that we are in the parent block merkle tree
    const merkleRoot = this.coinbaseBranch.getHash(this.tx.getHash())
    if (!merkleRoot.equals(this.parentBlock.merkleRoot)) {
      throw Error('AuxPoW merkle root incorrect')
    }

    // Check that the same work is not submitted twice to our chain.
    const pcHead = script.indexOf(mergedMiningHeader)
    if (pcHead !== -1) {
      // Enforce only one chain merkle root by checking that a single instance of the merged
      // mining header exists just before.
      if (script.slice(pcHead + 1).indexOf(mergedMiningHeader) !== -1) {
        throw Error('Multiple merged mining headers in coinbase')
      }
      if (pcHead + mergedMiningHeader.length !== pc) {
        throw Error('Merged mining header is not just before chain merkle root')
      }
    } else {
      // For backward compatibility.
      // Enforce only one chain merkle root by checking that it starts early in the coinbase.
      // 8-12 bytes are enough to encode extraNonce and nBits.
      if (pc > 20) {
        throw Error('AuxPoW chain merkle root must start in the first 20 bytes of the parent coinbase')
      }
    }

    // Ensure we are at a deterministic point in the merkle leaves by hashing
    // a nonce and our chain ID and comparing to the index.
    pc += rootHash.length
    if (script.length - pc < 8) {
      throw Error('AuxPoW missing chain merkle tree size and nonce in parent coinbase')
    }

    const size = script.readInt32LE(pc)
    const merkleHeight = this.blockchainBranch.hashes.length
    if (size !== (1 << merkleHeight)) {
      throw Error('AuxPoW merkle branch size does not match parent coinbase')
    }

    const nonce = script.readInt32LE(pc + 4)
    const expected = getExpectedIndex(nonce, chainId, merkleHeight)
    if (this.blockchainBranch.sideMask !== expected) {
      throw Error('AuxPoW wrong index')
    }
  }
}

class DogeBlock extends Block {
  constructor () {
    super()
    this.auxPoW = null
  }

  /**
   * Mode can be:
   *  - 0: Headers only, no AuxPoW
   *  - 1: Try to parse AuxPoW
   *  - 2: Try to parse transactions
   */
  static fromBuffer (buf, mode) {
    return DogeBlock.fromBufferWrap(new BufferWrap(buf), mode)
  }

  static fromBufferWrap (w, mode = 2) {
    const b = new DogeBlock()
    b.version = w.readUInt32()
    b.prevHash = w.read(32)
    b.merkleRoot = w.read(32)
    b.timestamp = w.readUInt32()
    b.bits = w.readUInt32()
    b.nonce = w.readUInt32()
    if (mode >= 1 && !w.isEof() && b.isAuxPoW()) {
      b.auxPoW = AuxPoW.fromBufferWrap(w)
    }
    if (mode >= 2 && !w.isEof()) {
      b.transactions = w.readList((w) => w.readObject(Transaction, true))
    }
    return b
  }

  static fromHex (hex, mode) {
    return DogeBlock.fromBuffer(Buffer.from(hex, 'hex'), mode)
  }

  byteLength (mode = 2) {
    if (typeof mode === 'boolean') mode = mode ? 1 : 2  // bitcoinjs-lib compat

    let size = 80
    if (mode >= 1 && this.isAuxPoW()) {
      size += this.auxPoW.byteLength()
    }
    if (mode >= 2 && this.transactions) {
      size += varuint.encodingLength(this.transactions.length)
      size += this.transactions.reduce((n, tx) => n + tx.byteLength(), 0)
    }
    return size
  }

  toBuffer (mode) {
    if (typeof mode === 'boolean') mode = mode ? 1 : 2  // bitcoinjs-lib compat

    const buffer = Buffer.alloc(this.byteLength(mode))
    this.toBufferWrap(new BufferWrap(buffer), mode)
    return buffer
  }

  toBufferWrap (w, mode = 2) {
    w.writeUInt32(this.version)
    w.write(this.prevHash)
    w.write(this.merkleRoot)
    w.writeUInt32(this.timestamp)
    w.writeUInt32(this.bits)
    w.writeUInt32(this.nonce)
    if (mode >= 1 && !w.isEof() && this.isAuxPoW()) {
      this.auxPoW.toBufferWrap(w)
    }
    if (mode >= 2 && !w.isEof()) {
      w.writeList(this.transactions, (w, tx) => w.writeObject(tx))
    }
  }

  // Extract the version number from the version field.
  getVersion () {
    return this.version & 0xff
  }

  // Extract the chain ID from the version field.
  getChainId () {
    return this.version >> 16
  }

  // Extract the auxpow flag from the version field.
  isAuxPoW () {
    return !!(this.version & 0x100)
  }

  // Check whether this is a "legacy" block without chain ID.
  isLegacy () {
    const version = this.getVersion()
    return version === 1 || (version === 2 && this.getChainId() === 0)
  }

  // Get the hash for this block.
  // Overridden to ensure we only hash the basic headers, not AuxPoW.
  getHash () {
    return bcrypto.hash256(this.toBuffer(0))
  }

  // Get the proof-of-work hash for this block.
  getPoWHash () {
    return binding.scrypt(this.toBuffer(0))
  }

  // Get the proof-of-work hash used to verify this block.
  getMiningHash () {
    if (this.isAuxPoW()) {
      const auxBlockHash = reverse(this.getHash())
      this.auxPoW.check(auxBlockHash, this.getChainId())
      return reverse(this.parentBlock.getPoWHash())
    } else {
      return reverse(this.getPoWHash())
    }
  }

  // Verify the proof-of-work.
  checkProofOfWork () {
    const hash = this.getMiningHash()
    const target = Block.calculateTarget(this.bits)

    return hash.compare(target) <= 0
  }
}

// abstract-encoding compatible interface
const headerType = DogeBlock.headerType = {
  encode: (obj, buffer, offset) => {
    const wrap = new BufferWrap(buffer, offset)
    obj.toBufferWrap(wrap, 1)
    headerType.encode.bytes = wrap.offset - offset
  },
  decode: (buffer, start, end) => {
    const wrap = new BufferWrap(buffer.slice(start, end))
    const result = DogeBlock.fromBufferWrap(wrap, 1)
    headerType.decode.bytes = wrap.offset
    return result
  },
  encodingLength: (obj) => {
    return obj.byteLength(1)
  }
}

module.exports = DogeBlock
