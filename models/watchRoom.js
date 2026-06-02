'use strict';
const { Schema, model } = require('mongoose');

const watchRoomSchema = new Schema({
  roomId:        { type: String, unique: true, required: true },
  ownerId:       { type: String, required: true },
  ownerUsername: { type: String, default: '' },
  ownerAvatar:   { type: String, default: '' },
  invitedIds:    [{ type: String }],
  participants: [{
    userId:   String,
    username: String,
    avatar:   String,
    joinedAt: Number,
  }],
  title:        { type: String, required: true },
  status:       { type: String, default: 'waiting' },
  videoUrl:     { type: String, default: '' },
  videoLog:     [{ url: String, loadedAt: Number, loadedBy: String, loadedByUsername: String }],
  chatMessages: [{
    userId:    String,
    username:  String,
    avatar:    String,
    text:      { type: String, maxlength: 500 },
    timestamp: Number,
  }],
  playbackState: {
    playing:     { type: Boolean, default: false },
    currentTime: { type: Number,  default: 0 },
    updatedAt:   { type: Number,  default: 0 },
  },
  msgID:     { type: String, default: '' },
  channelId: { type: String, default: '' },
  startedAt: { type: Number, default: null },
  endedAt:   { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = model('WatchRoom', watchRoomSchema);
