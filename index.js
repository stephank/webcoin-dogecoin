const u = require('bitcoin-util')
const BN = require('bn.js')
const createParams = require('webcoin-params')
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

  // Clamp timespan
  let timespan = actualTimespan
  let minTimespan, maxTimespan
  if (consensus.digishield) {
    // Amplitude filter
    timespan = targetTimespan + Math.floor((timespan - targetTimespan) / 8)
    minTimespan = targetTimespan - Math.floor(targetTimespan / 4)
    maxTimespan = targetTimespan + Math.floor(targetTimespan / 2)
  } else if (height > 10000) {
    minTimespan = Math.floor(targetTimespan / 4)
    maxTimespan = Math.floor(targetTimespan * 4)
  } else if (height > 5000) {
    minTimespan = Math.floor(targetTimespan / 8)
    maxTimespan = Math.floor(targetTimespan * 4)
  } else {
    minTimespan = Math.floor(targetTimespan / 16)
    maxTimespan = Math.floor(targetTimespan * 4)
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

const params = createParams({
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
    staticPeers: []
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
      if (!(header instanceof DogeBlock)) {
        header = Object.assign(new DogeBlock(), header)
      }

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
    }
  },

  wallet: require('bitcoinjs-lib').networks.dogecoin
})

// These are trashed by `createParams`, so do them here.
params.blockchain.Block = params.net.Block = params.Block = DogeBlock

params.blockchain.checkpoints = [
  {
    height: 144999,
    header: {
      version: 2,
      prevHash: u.toHash('2e910459e9ec3062e7b4e2cfb569c579b43254da53cdd98da671d4ecdeb6a018'),
      merkleRoot: u.toHash('d0279ba883ca04d216735dcf2978beafeaae852ddf8b7ecf7881c9a29091b74f'),
      timestamp: 1395094427,
      bits: 0x1b499dfd,
      nonce: 3341239808
    }
  },
  {
    height: 145000,
    header: {
      version: 2,
      prevHash: u.toHash('919a380db4b45eb97abb131633d87ff690387ebe03ac76690da3f4d681400558'),
      merkleRoot: u.toHash('316614dcd65aa75888cfe1ebb2190740bd8d1fc3e30a0c1952062740b1419c33'),
      timestamp: 1395094679,
      bits: 0x1b499dfd,
      nonce: 1200826624
    }
  }
]

module.exports = params
