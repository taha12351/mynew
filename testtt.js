const Discord = require('discord.js');
const client = require('./index.js');

module.exports = {
    name: 'profile',
    description: 'View your profile',
    aliases: ['profilo', 'pf'],
    usage: 'profile',
    run: async (client, message, args) => {
        const user = message.author;
        const canvas = require('canvas');
        const { Attachment } = require('discord.js');
        const profile = await canvas.loadImage('./output/profile.png');
        const pfp = await canvas.loadImage(user.displayAvatarURL({ format: 'png' }));
        const c = canvas.createCanvas(800, 400);
        const ctx = c.getContext('2d');
        ctx.drawImage(profile, 0, 0, 800, 400);
        ctx.drawImage(pfp, 50, 50, 100, 100);
        ctx.font = '20px Arial';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`Name: ${user.username}`, 200, 50);
        ctx.fillText(`ID: ${user.id}`, 200, 80);
        ctx.fillText(`Level: 1`, 200, 110);
        const attachment = new Attachment(c.toBuffer(), 'profile.png');
        message.channel.send({ files: [attachment] });
    }
};