const { Block, Transaction } = require('bitcoinjs-lib')
const varuint = require('varuint-bitcoin')
const reverse = require('buffer-reverse')
const crypto = require('crypto')
const BufferWrap = require('./buffer_wrap')
const binding = require('./build/Release/binding.node')

const mergedMiningHeader = Buffer.from([0xfa, 0xbe, 0x6d, 0x6d])

const hashTwo = (buf1, buf2) => {
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
    b.hashes = w.readList((w) => w.readSlice(32))
    b.sideMask = w.readInt32()
    return b
  }

  byteLength () {
    return 4 + varuint.encodingLength(this.hashes.length) +
      this.hashes.length * 32
  }

  getHash (hash) {
    let m = this.sideMask
    if (m === -1) return null
    for (const node of this.hashes) {
      if (m & 1) {
        hash = hashTwo(node, hash)
      } else {
        hash = hashTwo(hash, node)
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
    this.tx = w.readType(Transaction, true)
    this.blockHash = w.readSlice(32)
    this.coinbaseBranch = MerkleBranch.fromBufferWrap(w)
    this.blockchainBranch = MerkleBranch.fromBufferWrap(w)
    // Limiting the slice here ensures only headers are parsed.
    this.parentBlock = DogeBlock.fromBuffer(w.readSlize(80))
  }

  byteLength () {
    return 112 + this.tx.byteLength() +
      this.coinbaseBranch.byteLength() + this.blockchainBranch.byteLength()
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

  static fromBuffer (buf) {
    return DogeBlock.fromBufferWrap(new BufferWrap(buf))
  }

  static fromBufferWrap (w) {
    const b = new DogeBlock()
    b.version = w.readInt32()
    b.prevHash = w.readSlice(32)
    b.merkleRoot = w.readSlice(32)
    b.timestamp = w.readUInt32()
    b.bits = w.readUInt32()
    b.nonce = w.readUInt32()
    if (!w.isEof() && b.isAuxPoW()) {
      b.auxPoW = AuxPoW.fromBufferWrap(w)
    }
    if (!w.isEof()) {
      b.transactions = w.readList((w) => w.readType(Transaction, true))
    }
    return b
  }

  static fromHex (hex) {
    return DogeBlock.fromBuffer(Buffer.from(hex, 'hex'))
  }

  // Get the byte size required for encoding this block.
  byteLength (headersOnly) {
    let size = 80
    if (this.isAuxPoW()) {
      size += this.auxPoW.byteLength()
    }
    if (!headersOnly && this.transactions) {
      size += varuint.encodingLength(this.transactions.length)
      size += this.transactions.reduce((n, tx) => n + tx.byteLength(), 0)
    }
    return size
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

  // Get the proof-of-work hash for this block.
  getPoWHash () {
    return binding.scrypt(this.toBuffer(true))
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

module.exports = DogeBlock
