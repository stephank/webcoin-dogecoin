const u = require('bitcoin-util')
const BN = require('bn.js')
const proto = require('bitcoin-protocol')
const DogeBlock = require('./block')

class Consensus {
  constructor (params) {
    Object.assign(this, params)
    this.interval = this.targetTimespan / this.targetSpacing
  }

  extend (params) {
    return new Consensus(Object.assign({}, this, params))
  }
}

// Pre-digishield
const plainConsensus = new Consensus({
  targetTimespan: 4 * 60 * 60,  // 4 hours
  targetSpacing: 60,  // 1 minute
  powLimit: new BN('00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 16),
  digishield: false,
  auxPoW: false  // Actually unused right now
})

// Pre-auxPoW
const digishieldConsensus = plainConsensus.extend({
  targetTimespan: 60,  // 1 minute
  digishield: true
})

// Current
const auxPoWConsensus = digishieldConsensus.extend({
  auxPoW: true
})

// Get the consensus to use at the given height.
Consensus.get = (height) => {
  if (height < 145000) return plainConsensus
  if (height < 371337) return digishieldConsensus
  return auxPoWConsensus
}

// Calculate target based on the given consensus params, and previous block span.
const calculateTarget = (height, consensus, startBlock, endBlock) => {
  const targetTimespan = consensus.targetTimespan

  // Actual time taken to complete the interval
  const actualTimespan = endBlock.header.timestamp - startBlock.header.timestamp

  // Clamp timespan. The `|0` operation is used to perform integer rounding.
  // The values are small enough to not touch the sign bit.
  let timespan = actualTimespan
  let minTimespan, maxTimespan
  if (consensus.digishield) {
    // Amplitude filter
    timespan = targetTimespan + ((timespan - targetTimespan) / 8 | 0)
    minTimespan = targetTimespan - (targetTimespan / 4 | 0)
    maxTimespan = targetTimespan + (targetTimespan / 2 | 0)
  } else if (height > 10000) {
    minTimespan = targetTimespan / 4 | 0
    maxTimespan = targetTimespan * 4 | 0
  } else if (height > 5000) {
    minTimespan = targetTimespan / 8 | 0
    maxTimespan = targetTimespan * 4 | 0
  } else {
    minTimespan = targetTimespan / 16 | 0
    maxTimespan = targetTimespan * 4 | 0
  }
  timespan = Math.min(maxTimespan, timespan)
  timespan = Math.max(minTimespan, timespan)

  // Calculate target
  let target = new BN(u.expandTarget(endBlock.header.bits))
  target.imuln(timespan)
  target.idivn(targetTimespan)
  if (target.cmp(consensus.powLimit) === 1) {
    target = consensus.powLimit
  }
  return target.toBuffer('be', 32)
}

const params = {
  net: {
    magic: 0xc0c0c0c0,
    defaultPort: 22556,
    defaultWebPort: 25592,
    webSeeds: [],
    dnsSeeds: [
      'seed.multidoge.org',
      'seed2.multidoge.org',
      'seed.dogecoin.com',
      'seed.doger.dogecoin.com'
    ],
    staticPeers: [],
    messages: proto.messages.createStructs({
      header: DogeBlock.headerType
    })
  },

  blockchain: {
    shouldRetarget: (block, cb) => {
      const height = block.height
      const { interval } = Consensus.get(height)
      return cb(null, height % interval === 0)
    },

    calculateTarget: (block, chain, cb) => {
      const height = block.height
      const consensus = Consensus.get(height)
      chain.getBlock(block.header.prevHash, (err, endBlock) => {
        if (err) return cb(err)

        // Go back the full period unless it's the first retarget after genesis.
        // This fixes an issue where a 51% attack can change difficulty at will.
        let delta = consensus.interval
        if (height !== consensus.interval) delta += 1

        chain.getBlockAtHeight(height - delta, (err, startBlock) => {
          if (err) return cb(err)

          cb(null, calculateTarget(height, consensus, startBlock, endBlock))
        })
      })
    },

    miningHash: (header, cb) => {
      let hash
      try {
        hash = header.getMiningHash(header)
      } catch (err) {
        cb(err)
        return
      }
      cb(null, hash)
    },

    genesisHeader: {
      version: 1,
      prevHash: u.nullHash,
      merkleRoot: u.toHash('5b2a3f53f605d62c53e62932dac6925e3d74afa5a4b459745c36d42d0ed26a69'),
      timestamp: 1386325540,
      bits: 0x1e0ffff0,
      nonce: 99943
    },

    checkpoints: require('./checkpoints').read()
  },

  wallet: require('bitcoinjs-lib').networks.dogecoin
}

params.blockchain.Block = params.net.Block = params.Block = DogeBlock

module.exports = params
