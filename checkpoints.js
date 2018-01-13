const fs = require('fs')
const path = require('path')
const S = require('varstruct')
const DogeBlock = require('./block')

const magic = Buffer.from('Doge checkpoints v1\n')
const struct = S([
  ['magic', S.Value(S.Buffer(magic.length), magic)],
  ['blocks', S.VarArray(S.UInt32BE, S([
    ['height', S.UInt32BE],
    ['header', DogeBlock.headerType]
  ]))]
])

const file = path.join(__dirname, 'checkpoints.bin')
exports.read = () => struct.decode(fs.readFileSync(file)).blocks
exports.write = (blocks) => fs.writeFileSync(file, struct.encode({ blocks }))
