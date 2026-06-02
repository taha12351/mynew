const { Schema, model } = require('mongoose');

module.exports = model('StockPortfolio', new Schema({
  userId:          { type: String, required: true, unique: true },
  holdings: [{
    symbol:        { type: String },
    shares:        { type: Number, default: 0 },
    avgBuyPrice:   { type: Number, default: 0 },
  }],
  totalInvested:   { type: Number, default: 0 },
  realizedProfit:  { type: Number, default: 0 },
  totalTrades:     { type: Number, default: 0 },
  createdAt:       { type: Date,   default: Date.now },
}));
