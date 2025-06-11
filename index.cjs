// noinspection SpellCheckingInspection

require('dotenv').config();

const { Client, GatewayIntentBits} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, EndBehaviorType, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const prism = require('prism-media');
const path = require('path');
const { log } = require('console');
const { exec } = require('child_process');
//const {  } = require('ytdl');

const player = createAudioPlayer();
let alarms = [];
let connection = null;
let alarmongoing = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
// Call the command registration script
exec(`node ${path.join(__dirname, 'registerCommands.cjs')}`, (error, stdout, stderr) => {
  if (error) {
    log(`Error registering commands: ${error.message}`, 'error', 1);
    return;
  }
  if (stderr) {
    log(`Error output: ${stderr}`, 'error', 1);
    return;
  }
  log(`Command registration output: ${stdout}`, 'info', 2);
});

const TOKEN = process.env.DISCORD_TOKEN;
const botnames = process.env.BOT_TRIGGERS.split(',');
if (!Array.isArray(botnames)) {
  log('BOT_TRIGGERS must be an array of strings', 'error', 1);
  process.exit(1);
}
log(`Bot triggers: ${botnames}`, 'info', 1);
let chatHistory = {};
let threadMemory = {};

let transcribemode = false;

let allowwithouttrigger = false;
let allowwithoutbip = false;
let currentlythinking = false;

// Create the directories if they don't exist
if (!fs.existsSync('./recordings')) {
  fs.mkdirSync('./recordings');
}
if (!fs.existsSync('./sounds')) {
  fs.mkdirSync('./sounds');
}


client.on('ready', () => {
  // Clean up any old recordings
  fs.readdir('./recordings', (err, files) => {
    if (err) {
      logToConsole('Error reading recordings directory', 'error', 1);
      return;
    }
    files.forEach(file => {
    fs.unlinkSync(`./recordings/${file}`);
    });
    });
    logToConsole(`Logged in as ${client.user.tag}!`, 'info', 1);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    switch (commandName) {
      case 'join':
        const mode = options.getString('mode');
        // Your join logic here, using `mode` as the option
        if (connection) {
          await interaction.reply({
            content:
              'I am already in a voice channel. Please use the `leave` command first.',
            flags: 'Ephemeral',
          });
          return;
        }

        allowwithoutbip = false;
        allowwithouttrigger = false;
        transcribemode = false;

        if (mode === 'silent') {
          allowwithoutbip = true;
        } else if (mode === 'free') {
          allowwithouttrigger = true;
        } else if (mode === 'transcribe') {
          transcribemode = true;
        }

        if (interaction.member.voice.channel) {
          connection = joinVoiceChannel({
            channelId: interaction.member.voice.channel.id,
            channelName: interaction.member.voice.channel.name,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: false,
            maxAudioLength: 60 * 1000,
          });
          if (transcribemode) {
            await sendToTTS(
              'Transcription mode is enabled for this conversation. Once you type the leave command, a transcription of the conversation will be sent in the channel.',
              interaction.user.id,
              connection,
              interaction.member.voice.channel,
            );
          }
          logToConsole('> Joined voice channel: ' + interaction.member.voice.channel.name, 'info', 1);
          await handleRecording(connection, interaction.member.voice.channel);
          await interaction.reply({
            content: `Joined voice channel: ${interaction.member.voice.channel.name}`,
            flags: 'Ephemeral',
          });
        } else {
          await interaction.reply({
            content: 'You need to join a voice channel first!',
            flags: 'Ephemeral',
          });
        }
        break;

      case 'reset':
        chatHistory = {};
        await interaction.reply({
          content: 'Chat history reset!',
          flags: 'Ephemeral',
        });
        logToConsole('> Chat history reset!', 'info', 1);
        break;

      case 'play':
        const query = options.getString('query');
        if (interaction.member.voice.channel) {
          currentlythinking = true;
          await seatchAndPlayYouTube(
            query,
            interaction.user.id,
            connection,
            interaction.member.voice.channel,
          );
          await interaction.reply(`Playing: ${query}`);
        } else {
          await interaction.reply({
            content: 'You need to join a voice channel first!',
            flags: 'Ephemeral',
          });
        }
        break;

      case 'leave':
        if (connection) {
          connection.destroy();
          audioqueue = [];

          if (transcribemode) {
            await interaction
              .reply({ files: ['./transcription.txt'] })
              .then(() => {
                fs.unlinkSync('./transcription.txt');
              });
          }

          connection = null;
          chatHistory = {};
          logToConsole('> Left voice channel', 'info', 1);
          await interaction.reply({
            content: 'Left voice channel.',
            flags: 'Ephemeral',
          });
        } else {
          await interaction.reply({
            content: 'I am not in a voice channel.',
            flags: 'Ephemeral',
          });
        }
        break;

      case 'search':
        const searchQuery = options.getString('query');
        currentlythinking = true;
        logToConsole(`> Search query: ${searchQuery}`, 'info', 1);

        // Acknowledge the interaction immediately
        await interaction.deferReply();

        const response = await sendTextToPerplexity(searchQuery);
        const messageParts = splitMessage(response);

        for (const part of messageParts) {
          try {
            // Edit the initially deferred reply with the first part
            await interaction.editReply(part);
            // For later parts, use follow-up messages
            for (let i = 0; i < audioqueue.length; i++) {
              const audioFile = audioqueue[i];
              logToConsole(`Writing audio queue item ${i} of ${audioqueue.length}: ${audioFile}`, 'info', 2);

              if (i < audioqueue.length - 1) {
                await connection.play(audioqueue[i + 1]);
                logToConsole(`> Audio queue item ${i + 1} of ${audioqueue.length}: ${audioqueue[i + 1].name}`, 'info', 2);
              }
            }
          } catch (error) {
            console.error(`Failed to send message part: ${error}`);
            await interaction.followUp(
              'Oops! I encountered an error while sending my response.',
            );
            break;
          }
        }
        break;

      case 'reminder':
        const time = options.getString('time');
        const message = options.getString('message');
        const userid = interaction.user.id;

        // We need to parse the "time" option to get the timestamp. The format is the official discord one, <t:UNIX_TIMESTAMP>.
        const timestamp = time.match(/<t:(\d+)>/);
        if (!timestamp || timestamp.length < 2) {
          await interaction.reply({
            content: `Incorrect timestamp format.`,
            flags: 'Ephemeral',
          });
          return;
        }

        // Schedule the reminder
        await scheduleReminder(timestamp[1], message, userid);

        await interaction.reply({
          content: `Reminder set for ${time}.`,
          flags: 'Ephemeral',
        });

        break;

      case 'help':
        await interaction.reply({
          content: `Commands: \n
      \`/join\` - Join voice channel and start listening for trigger words.
      \`/join silent\` - Join voice channel without the confirmation sounds.
      \`/join free\` - Join voice channel and listen without trigger words.
      \`/join transcribe\` - Join voice channel and save the conversation to a file which will be sent when using \`/leave\` command.
      \`/reset\` - Reset chat history. You may also say \`reset chat history\` in voice chat.
      \`/play\` [song name or URL] - Play a song from YouTube. You may also say \`play [query] on YouTube\` or \`play [query] song\` with the bot trigger word.
      \`/leave\` - Leave voice channel. You may also say \`leave voice chat\` in voice chat.
      \`/help\` - Display this message. \n
      __Notes:__
      If vision is enabled, sending an image mentioning the bot will have it react to it in voice chat.
      A valid API key is required for the YouTube feature.`,
          flags: 'Ephemeral',
        });
        break;
    }
  });

  client.on('messageCreate', async (message) => {
    // Ignore own messages, system messages, and everyone mentions
    if (message.author.id === client.user.id || message.system) return;
    if (message.mentions.everyone === true) return;
    // Check if the bot was mentioned with a picture attached
    if (
      message.mentions.has(client.user) &&
      message.attachments.size > 0 &&
      message.member.voice.channel
    ) {
      // Get image URL from the message
      const imageUrl = message.attachments.first().url;
      const userId = message.author.id;
      await captionImage(imageUrl, userId, connection, message.member.voice.channel);
      return;
    }

    let isMention = message.mentions.has(client.user);
    let isReply = message.reference && message.reference.messageId;
    let isInThread =
      message.channel.isThread() && (await isThreadFromBot(message));

    if (process.env.LLM_TEXT.toLowerCase() === 'false') {
      isMention = false;
      isReply = false;
      isInThread = false;
    }

    if (isInThread) {
      const threadId = message.channel.isThread() ? message.channel.id : null;

      await message.channel.sendTyping();
      logToConsole('> Message in thread', 'info', 1);
      // Handle messages within a thread
      const response = await sendToLLMInThread(message, threadId);
      const messageParts = splitMessage(response);

      for (const part of messageParts) {
        try {
          await message.channel.send(part);
        } catch (error) {
          console.error(`Failed to send message part: ${error}`);
          await message.channel.send(
            'Oops! I encountered an error while sending my response.',
          );
          break;
        }
      }
    } else if (isReply) {
      // Continue the conversation
      const repliedMessage = await message.channel.messages.fetch(
        message.reference.messageId,
      );
      if (repliedMessage.author.id !== client.user.id) return; // Only continue if replying to the bot's message
      await message.channel.sendTyping();
      let nick = message.author.username;
      let clientid = String(client.user.id);
      let text = message.content.replace('<@'+ clientid + '>', '');
      let final = nick + ": " + text;
      logToConsole('> Reply to message', 'info', 1);
      const response = await sendTextToLLM(final);

      const messageParts = splitMessage(response);

      // Send the first part as a reply
      try {
        await message.reply(messageParts[0]);
      } catch (error) {
        console.error(`Failed to send reply: ${error}`);
        await message.channel.send(
          'Oops! I encountered an error while sending my response.',
        );
        return; // Stop further processing if the reply fails
      }

      // Send the remaining parts as regular messages
      for (let i = 1; i < messageParts.length; i++) {
        try {
          await message.channel.send(messageParts[i]);
        } catch (error) {
          console.error(`Failed to send message part: ${error}`);
          // Optionally, send a message to the channel indicating an error occurred
          await message.channel.send(
            'Oops! I encountered an error while sending my response.',
          );
          break; // Stop sending more parts to avoid spamming in case of persistent errors
        }
      }
    } else if (isMention) {
      await message.channel.sendTyping();
      logToConsole('> Mentioned in message', 'info', 1);
      //logToConsole(message.content, 'info', 2)

      let nick = message.author.username;
      let clientid = String(client.user.id);
      let text = message.content.replace('<@'+ clientid + '>', '');
      let final = nick + ": " + text;
      logToConsole(final, 'info', 2)
      message.content = final;
      logToConsole(message.content, 'info', 2);

      // Start a new conversation
      const response = await sendTextToLLM(message);
      const messageParts = splitMessage(response);

      // Send the first part as a reply
      try {
        await message.reply(messageParts[0]);
      } catch (error) {
        console.error(`Failed to send reply: ${error}`);
        await message.channel.send(
          'Oops! I encountered an error while sending my response.',
        );
        return; // Stop further processing if the reply fails
      }

      // Send the remaining parts as regular messages
      for (let i = 1; i < messageParts.length; i++) {
        try {
          await message.channel.send(messageParts[i]);
        } catch (error) {
          console.error(`Failed to send message part: ${error}`);
          // Optionally, send a message to the channel indicating an error occurred
          await message.channel.send(
            'Oops! I encountered an error while sending my response.',
          );
          break; // Stop sending more parts to avoid spamming in case of persistent errors
        }
      }
    }
  });
  //Start of Recording Block
  function handleRecording(connection, channel) {
    const receiver = connection.receiver;
    if (!receiver){
      logToConsole(`>Error: Receiver not found ln:393`, 'error', 2)
      return;
    }
    channel.members.forEach((member) => {
      if (member.user.bot) return;

      const filePath = `./recordings/${member.user.id}.pcm`;
      const writeStream = fs.createWriteStream(filePath);
      const name = member.user.username
      const listenStream = receiver.subscribe(
        member.user.id,
        {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: process.env.WAIT_TIME,
          },
        },
        { MaxListeners: 50},
      );

      const opusDecoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 1,
        rate: 48000
      });

      listenStream.pipe(opusDecoder).pipe(writeStream);

      writeStream.on('finish', () => {
        logToConsole(`> Audio recorded for ${name}`, 'info', 2);
        convertAndHandleFile(filePath, member.user.id, name, connection, channel);
      });
    });
  }

  function handleRecordingForUser(userid, connection, channel) {
    const receiver = connection.receiver;
    if (!receiver){
      logToConsole(`>Error: Receiver not found ln:428`, 'error', 2)
      return;
    }
    channel.members.forEach((member) => {
      if (member.user.bot) return;

      const filePath = `./recordings/${member.user.id}.pcm`;
      const writeStream = fs.createWriteStream(filePath);
      const name = member.user.username
      const listenStream = receiver.subscribe(member.user.id, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: process.env.WAIT_TIME,
        },
      });
      const opusDecoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 1,
        rate: 48000,
      });

      listenStream.pipe(opusDecoder).pipe(writeStream);

      writeStream.on('finish', () => {
        logToConsole(`> Audio recorded for ${name}`, 'info', 2);
        convertAndHandleFile(filePath, userid, name, connection, channel);
      });
    });
  }

  function convertAndHandleFile(filePath, userid, name, connection, channel) {
    const mp3Path = filePath.replace('.pcm', '.mp3');
    ffmpeg(filePath)
      .inputFormat('s16le')
      .audioChannels(1)
      .format('mp3')
      .on('error', (err) => {
        logToConsole(`X Error converting file: ${err.message}`, 'error', 1);
        currentlythinking = false;
      })
      .save(mp3Path)
      .on('end', () => {
        logToConsole(`> Converted to MP3: ${mp3Path}`, 'info', 2);
        sendAudioToAPI(mp3Path, userid, name, connection, channel);
      });
  }
//Send recording to STT API to Transcribe

  async function sendAudioToAPI(fileName, userid, name, connection, channel) {

    // Input validation
    if (!fileName || !userid || !name || !connection || !channel) {
      throw new Error('Invalid input parameters');
    }

    const formData = new FormData();
    //formData.append('model', process.env.STT_MODEL);
    formData.append('audio_file', fs.createReadStream(fileName), {
      ContentType: 'audio/form-data',
      audio_file: 'fileName',
      accept: 'application/json',
    });
 //This sends a request to the STT
    try {
      const response = await axios.post(
        process.env.STT_ENDPOINT + '/asr?encode=true&task=transcribe&language=en&vad_filter=true&word_timestamps=false&output=txt',
        formData,
        {
          headers: formData.headers,
        },
      );

   let result = response.data;
   let transcription = 'VOICECHAT: ' + name + `: ` + result;
   let transcriptionwithoutpunctuation = result.replace(
     /[.,\/#!$%^&*;:{}=\-_`~()]/g,
     '',
   );
   transcriptionwithoutpunctuation =
     transcriptionwithoutpunctuation.toLowerCase();
   logToConsole(`${transcription}`, 'info', 2);
   const ignoreTriggers = ['Thank you.', 'Bye.'];
   if (ignoreTriggers.some((trigger) => transcription.includes(trigger))) {
     logToConsole('> Ignoring background/keyboard sounds.', 'info', 2);
     restartListening(userid, connection, channel);
     return;
   }


        //logToConsole(
         // `> Transcription: ${transcription}`,
         // 'info',
         // 1,
        //);

        // If the alarm is ongoing and transcription is 'stop', stop the alarm
        if (
          (alarmongoing || currentlythinking) &&
          (transcriptionwithoutpunctuation.toLowerCase().includes('stop') ||
            transcriptionwithoutpunctuation.toLowerCase().includes('shut up') ||
            transcriptionwithoutpunctuation.toLowerCase().includes('fuck off'))
        ) {
          await playSound(connection, 'command');
          alarmongoing = false;
          currentlythinking = false;
          chatHistory = {};
          player.stop();
          logToConsole('> Bot stopped.', 'info', 1);
          restartListening(userid, connection, channel);
          return;
        }



        // Check if the transcription includes the bot's name
        if (
          botnames.some((name) => {
            const regex = new RegExp(`\\b${name}\\b`, 'i');
            return regex.test(result) || allowwithouttrigger;
          })
        ) {
          // Ignore if the string is a single word
          if (result.split(' ').length <= 1) {
            currentlythinking = false;
            logToConsole('> Ignoring single word command.', 'info', 2);
            restartListening(userid, connection, channel);
            return;
          }

          // Remove the first occurrence of the bot's name from the transcription
          for (const name of botnames) {
            result = result
              .replace(new RegExp(`\\b${name}\\b`, 'i'), '')
              .trim();
          }
          if(
            transcriptionwithoutpunctuation.includes('hang') &&
            transcriptionwithoutpunctuation.includes('on')
          ) {
            await playSound(connection, 'command');
            currentlythinking = false;
            chatHistory = {};
            player.pause();
            restartListening(userid, connection, channel);
            return;
          }else if (
            transcriptionwithoutpunctuation.includes('please') &&
            transcriptionwithoutpunctuation.includes('continue')
          ) {
            await playSound(connection, 'command');
            currentlythinking = false;
            chatHistory = {};
            player.unpause();
            restartListening(userid, connection, channel);
            return;
            } else if (
              transcriptionwithoutpunctuation.includes('stop') ||
              transcriptionwithoutpunctuation.includes('shut up') ||
              transcriptionwithoutpunctuation.includes('fuck off')
          ) {
            await playSound(connection, 'command');
            currentlythinking = false;
            chatHistory = {};
            player.stop();
            logToConsole('> Bot stopped.', 'info', 1);
            restartListening(userid, connection, channel);
            return;
          }

          if (currentlythinking) {
              logToConsole(
              '> Bot is already thinking, ignoring transcription.',
              'info',
              2,
            );
            restartListening(userid, connection, channel);
            return;
          }
          // Check if transcription is a command
          if (
            transcriptionwithoutpunctuation.includes('reset') &&
            transcriptionwithoutpunctuation.includes('chat') &&
            transcriptionwithoutpunctuation.includes('history')
          ) {
            await playSound(connection, 'command');
            currentlythinking = false;
            chatHistory = {};
            logToConsole('> Chat history reset!', 'info', 1);
            restartListening(userid, connection, channel);
            return;
          } else if (
            transcriptionwithoutpunctuation.includes('leave') &&
            transcriptionwithoutpunctuation.includes('voice') &&
            transcriptionwithoutpunctuation.includes('chat')
          ) {
            await playSound(connection, 'command');
            currentlythinking = false;
            connection.destroy();
            connection = null;
            chatHistory = {};
            logToConsole('> Left voice channel', 'info', 1);
            return;
          }

          // Check for specific triggers
          const songTriggers = [
            ['play', 'song'],
            ['play', 'youtube'],
          ];
          const timerTriggers = [
            ['set', 'timer'],
            ['start', 'timer'],
            ['set', 'alarm'],
            ['start', 'alarm'],
          ];
          const internetTriggers = ['search', 'internet'];
          const cancelTimerTriggers = [
            ['cancel', 'timer'],
            ['cancel', 'alarm'],
            ['can sell', 'timer'],
            ['can sell', 'alarm'],
            ['consult', 'timer'],
            ['consult', 'alarm'],
          ];
          const listTimerTriggers = [
            ['list', 'timer'],
            ['list', 'alarm'],
            ['least', 'timer'],
            ['least', 'alarm'],
            ['when', 'next', 'timer'],
            ['when', 'next', 'alarm'],
          ];

          if (
            songTriggers.some((triggers) =>
              triggers.every((trigger) =>
                transcriptionwithoutpunctuation.includes(trigger),
              ),
            )
          ) {
            currentlythinking = true;
            await playSound(connection, 'understood');
            // Remove the song triggers from the transcription
            for (const trigger of songTriggers) {
              for (const word of trigger) {
                transcription = transcription.replace(word, '').trim();
              }
            }
            await seatchAndPlayYouTube(transcription, userid, connection, channel);
            restartListening(userid, connection, channel);
            return;
          } else if (
            timerTriggers.some((triggers) =>
              triggers.every((trigger) =>
                transcriptionwithoutpunctuation.includes(trigger),
              ),
            )
          ) {
            currentlythinking = true;
            await playSound(connection, 'understood');
            // Determine if the timer is for an alarm or a timer
            const timertype = transcription.toLowerCase().includes('alarm')
              ? 'alarm'
              : 'timer';

            // Remove the timer triggers from the transcription
            for (const trigger of timerTriggers) {
              for (const word of trigger) {
                transcription = transcription.replace(word, '').trim();
              }
            }
            // Send it to timer API
            await setTimer(transcription, timertype, userid, connection, channel);
            restartListening(userid, connection, channel);
            return;
          } else if (
            cancelTimerTriggers.some((triggers) =>
              triggers.every((trigger) =>
                transcriptionwithoutpunctuation.includes(trigger),
              ),
            )
          ) {
            await playSound(connection, 'understood');
            // Remove the cancel timer triggers from the transcription
            for (const word of cancelTimerTriggers) {
              transcription = transcription.replace(word, '').trim();
            }

            // Check for an ID in the transcription, else list the timers with their ID and time
            let timerId = transcription.match(/\d+/);
            if (!timerId) {
              const converttable = {
                one: 1,
                two: 2,
                three: 3,
                four: 4,
                five: 5,
                six: 6,
                seven: 7,
                eight: 8,
                nine: 9,
                first: 1,
                second: 2,
                third: 3,
                fourth: 4,
                fifth: 5,
                sixth: 6,
                seventh: 7,
                eighth: 8,
                ninth: 9,
              };

              const timeValueText = query.match(
                /one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth/g,
              );
              if (timeValueText) {
                timerId = [converttable[timeValueText[0]]];
              }
            }

            if (timerId) {
              // Cancel the timer with the given ID
              cancelTimer(timerId[0], userid, connection, channel);
            } else {
              // List the timers
              if (alarms.length > 1) {
                await sendToTTS(
                  `Which one would you like to cancel? You have the following: ${alarms.map((alarm, index) => `${alarm.type} ${index + 1} set for ${alarm.time}`).join(', ')}`,
                  userid,
                  connection,
                  channel,
                );
              } else if (alarms.length === 1) {
                cancelTimer(1, userid, connection, channel);
              } else {
                await sendToTTS(
                  'There are no timers to cancel.',
                  userid,
                  connection,
                  channel,
                );
              }
            }

            restartListening(userid, connection, channel);
            return;
          } else if (
            listTimerTriggers.some((triggers) =>
              triggers.every((trigger) =>
                transcriptionwithoutpunctuation.includes(trigger),
              ),
            )
          ) {
            await playSound(connection, 'understood');
            listTimers(userid, connection, channel);
            restartListening(userid, connection, channel);
            return;
          } else if (
            internetTriggers.some((trigger) =>
              transcriptionwithoutpunctuation.includes(trigger),
            )
          ) {
            // Remove unwanted words from the transcription:
            // "for" after "search" or "internet"
            transcription = transcription.replace(/search for/g, 'search');
            transcription = transcription.replace(/internet for/g, 'internet');

            currentlythinking = true;
            await playSound(connection, 'understood');
            // Remove the internet triggers from the transcription
            for (const word of internetTriggers) {
              transcription = transcription.replace(word, '').trim();
            }
            // Send it to search API
            await sendToPerplexity(transcription, userid, connection, channel);
            restartListening(userid, connection, channel);
            return;
          }

          currentlythinking = true;
          await playSound(connection, 'understood');
          await sendToLLM(transcription, userid, connection, channel);
          logToConsole(`> Sending to LLM...`, 'info', 2)
          restartListening(userid, connection, channel);
        } else {
          currentlythinking = false;
          logToConsole(
            '> Bot was not addressed directly. Ignoring the command.',
            'info',
            2,
          );
          restartListening(userid, connection, channel);
        }
      }
    catch
      (error)
      {
        currentlythinking = false;
        logToConsole(
          `X Failed to transcribe audio: ${error.message}`,
          'error',
          1,
        );
        // Restart listening after an error
        restartListening(userid, connection, channel);
      }
    finally
      {
        // Ensure files are always deleted regardless of the transcription result
        try {
          fs.unlinkSync(fileName);
          const pcmPath = fileName.replace('.mp3', '.pcm'); // Ensure we have the correct .pcm path
          fs.unlinkSync(pcmPath);
        } catch (cleanupError) {
          // Log cleanup errors but continue
        }
      }
    }

  async function sendToLLM(transcription, userid, connection, channel) {
    let messages = chatHistory[userid] || [];

    // If this is the first message, add a system prompt
    if (messages.length === 0) {
      if (allowwithouttrigger) {
        messages.push({
          role: 'system',
          content: process.env.LLM_SYSTEM_PROMPT_FREE,
        });
      } else {
        messages.push({
          role: 'system',
          content: process.env.LLM_SYSTEM_PROMPT,
        });
      }
    }

    // Add the user's message to the chat history
    messages.push({
      role: 'user',
      content: transcription,
    });

    // Keep only the latest X messages
    const messageCount = messages.length;
    if (messageCount > process.env.MEMORY_SIZE) {
      messages = messages.slice(messageCount - process.env.MEMORY_SIZE);
    }

    try {
      const client = axios.create({
        baseURL: process.env.LLM_ENDPOINT,
        headers: {
          Authorization: `Bearer ${process.env.LLM_API}`,
          'Content-Type': 'application/json',
        },
      });

      // Chat completion without streaming
      client
        .post('/chat/completions', {
          model: process.env.LLM,
          messages: messages,
        })
        .then((response) => {
          const llmresponseraw = response.data.choices[0].message.content;
          //logToConsole(`> Raw LLM Response: ${llmresponseraw}`, 'info', 2);
          const llmresponse = llmresponseraw.replace('Bella:', '');

          logToConsole(`> LLM Edited Response: ${llmresponse}`, 'info', 1);

          if (llmresponse.includes('IGNORING')) {
            currentlythinking = false;
            logToConsole('> LLM Ignored the command.', 'info', 2);
            return;
          }

          // Store the LLM's response in the history
          messages.push({
            role: 'assistant',
            content: llmresponse,
          });

          // Update the chat history
          chatHistory[userid] = messages;

          // Update the transcription file if transcribe mode is enabled
          if (transcribemode) {
            // Check if the transcription file exists, if not, create it
            if (!fs.existsSync('./transcription.txt')) {
              fs.writeFileSync('./transcription.txt', '');
            }

            // Append the transcription to the file
            fs.appendFileSync(
              './transcription.txt',
              `${userid}: ${transcription}\n\nAssistant: ${llmresponse}\n\n`,
            );
          }

          // Send response to TTS service
          playSound(connection, 'result');
          sendToTTS(llmresponse, userid, connection, channel);
        })
        .catch((error) => {
          currentlythinking = false;
          logToConsole(
            `X Failed to communicate with LLM: ${error.message}`,
            'error',
            1,
          );
        });
    } catch (error) {
      currentlythinking = false;
      logToConsole(
        `X Failed to communicate with LLM: ${error.message}`,
        'error',
        1,
      );
    }
  }

  async function sendTextToLLM(message) {
    // Define the system message
    const systemMessage = {
      role: 'system',
      content: process.env.LLM_TEXT_SYSTEM_PROMPT,
    };

    let messages = [];

    // Fetch the message chain
    let currentMessage = message;
    const messageChain = [];

    while (currentMessage) {
      messageChain.push({
        role:
          currentMessage.author.id === client.user.id ? 'assistant' : 'user',
        content: currentMessage.content,
      });
      if (currentMessage.reference) {
        try {
          currentMessage = await message.channel.messages.fetch(
            currentMessage.reference.messageId,
          );
        } catch (error) {
          if (error.code === 10008) {
            console.error(`Failed to fetch message: ${error.message}`);
            break; // Exit the loop if the message is not found
          } else {
            throw error; // Re-throw other errors
          }
        }
      } else {
        currentMessage = null;
      }
    }

    // Reverse the message chain to maintain the correct order
    messageChain.reverse();

    // Add the message chain to the message array
    messages.push(...messageChain);

    // Keep only the latest X messages, excluding the system message in the count
    const messageCount = messages.length;
    if (messageCount >= process.env.MEMORY_SIZE) {
      // Slice the messages to keep only the latest X, considering the system message will be added
      messages = messages.slice(-(process.env.MEMORY_SIZE - 1));
    }

    // Add the system message at the beginning of the array
    messages.unshift(systemMessage);

    try {
      const client = axios.create({
        baseURL: process.env.LLM_ENDPOINT,
        headers: {
          Authorization: `Bearer ${process.env.LLM_API}`,
          'Content-Type': 'application/json',
        },
      });

      // Chat completion without streaming
      const response = await client.post('/chat/completions', {
        model: process.env.LLM,
        messages: messages,
      });

      const llmresponse = response.data.choices[0].message.content;

      logToConsole(`> LLM Text Response: ${llmresponse}`, 'info', 1);

      return llmresponse;
    } catch (error) {
      console.error(`Failed to communicate with LLM: ${error.message}`);
      return 'Sorry, I am having trouble processing your request right now.';
    }
  }

  async function sendToLLMInThread(message, threadId) {
    // Initialize thread memory if it doesn't exist
    if (!threadMemory[threadId]) {
      threadMemory[threadId] = [];

      // Fetch the last 20 messages from the thread
      const threadMessages = await message.channel.messages.fetch({
        limit: 20,
      });
      threadMessages.forEach((threadMessage) => {
        threadMemory[threadId].push({
          role:
            threadMessage.author.id === client.user.id ? 'assistant' : 'user',
          content: threadMessage.content,
        });
      });

      // Reverse the messages to maintain the correct order
      threadMemory[threadId].reverse();

      // Delete the first two messages due to the system message and the message that triggered the thread
      threadMemory[threadId].shift();
      threadMemory[threadId].shift();
    }

    // Define the system message
    const systemMessage = {
      role: 'system',
      content: process.env.LLM_TEXT_SYSTEM_PROMPT,
    };

    let messages = threadMemory[threadId];

    // Fetch the original message of the thread
    const threadParentMessage = await message.channel.fetchStarterMessage();
    if (threadParentMessage) {
      messages.push({
        role:
          threadParentMessage.author.id === client.user.id
            ? 'assistant'
            : 'user',
        content: threadParentMessage.content,
      });
    }

    // Add the message to the message array
    messages.push({
      role: message.author.id === client.user.id ? 'assistant' : 'user',
      content: message.content,
    });

    // Keep only the latest X messages, excluding the system message in the count
    const messageCount = messages.length;
    if (messageCount >= process.env.MEMORY_SIZE) {
      // Slice the messages to keep only the latest X, considering the system message will be added
      messages = messages.slice(-(process.env.MEMORY_SIZE - 1));
    }

    // Update the thread memory
    threadMemory[threadId] = messages;

    // Add the system message at the beginning of the array
    messages.unshift(systemMessage);

    console.log(messages);

    try {
      const client = axios.create({
        baseURL: process.env.LLM_ENDPOINT,
        headers: {
          Authorization: `Bearer ${process.env.LLM_API}`,
          'Content-Type': 'application/json',
        },
      });

      // Chat completion without streaming
      const response = await client.post('/chat/completions', {
        model: process.env.LLM,
        messages: messages,
      });

      const llmresponse = response.data.choices[0].message.content;

      // Add LLM response to the thread memory
      threadMemory[threadId].push({
        role: 'assistant',
        content: llmresponse,
      });

      logToConsole(`> LLM Text Response: ${llmresponse}`, 'info', 1);

      return llmresponse;
    } catch (error) {
      console.error(`Failed to communicate with LLM: ${error.message}`);
      return 'Sorry, I am having trouble processing your request right now.';
    }
  }

  async function sendToPerplexity(transcription, userId, connection, channel) {
    let messages = chatHistory[userId] || [];

    // Return error if the perplexity key is missing
    if (
      process.env.PERPLEXITY_API === undefined ||
      process.env.PERPLEXITY_API === '' ||
      process.env.PERPLEXITY_MODEL === 'MY_PERPLEXITY_API_KEY'
    ) {
      logToConsole('X Perplexity API key is missing', 'error', 1);
      await sendToTTS(
        'Sorry, I do not have access to internet. You may add a Perplexity API key to add this feature.',
        userId,
        connection,
        channel,
      );
      return;
    }

    // Refuse if perplexity is not allowed
    if (process.env.PERPLEXITY === 'false') {
      logToConsole('X Perplexity is not allowed', 'error', 1);
      await sendToTTS(
        'Sorry, I am not allowed to search the internet.',
        userId,
        connection,
        channel,
      );
      return;
    }

    // System prompt isn't allowed on Perplexity search

    // Add the user's message to the chat history
    messages.push({
      role: 'user',
      content: transcription,
    });

    // Keep only the latest X messages
    const messageCount = messages.length;
    if (messageCount > process.env.MEMORY_SIZE) {
      messages = messages.slice(messageCount - process.env.MEMORY_SIZE);
    }

    try {
      const client = axios.create({
        baseURL: process.env.PERPLEXITY_ENDPOINT,
        headers: {
          Authorization: `Bearer ${process.env.PERPLEXITY_API}`,
          'Content-Type': 'application/json',
        },
      });

      // Chat completion without streaming
      client
        .post('/chat/completions', {
          model: process.env.PERPLEXITY_MODEL,
          messages: messages,
        })
        .then((response) => {
          const llmresponse = response.data.choices[0].message.content;
          logToConsole(`> LLM Response: ${llmresponse}`, 'info', 1);

          if (llmresponse.includes('IGNORING')) {
            currentlythinking = false;
            logToConsole('> LLM Ignored the command.', 'info', 2);
            return;
          }

          // Store the LLM's response in the history
          messages.push({
            role: 'assistant',
            content: llmresponse,
          });

          // Update the chat history
          chatHistory[userId] = messages;

          // Send response to TTS service
          playSound(connection, 'result');
          sendToTTS(llmresponse, userId, connection, channel);
        })
        .catch((error) => {
          currentlythinking = false;
          logToConsole(
            `X Failed to communicate with LLM: ${error.message}`,
            'error',
            1,
          );
        });
    } catch (error) {
      currentlythinking = false;
      logToConsole(
        `X Failed to communicate with LLM: ${error.message}`,
        'error',
        1,
      );
    }
  }

  async function sendTextToPerplexity(transcription) {
    let messages = [];

    // Return error if the perplexity key is missing
    if (
      process.env.PERPLEXITY_API === undefined ||
      process.env.PERPLEXITY_API === '' ||
      process.env.PERPLEXITY_MODEL === 'MY_PERPLEXITY_API_KEY'
    ) {
      logToConsole('X Perplexity API key is missing', 'error', 1);
      return 'Sorry, I do not have access to internet. You may add a Perplexity API key to add this feature.';
    }

    // Refuse if perplexity is not allowed
    if (process.env.PERPLEXITY === 'false') {
      logToConsole('X Perplexity is not allowed', 'error', 1);
      return 'Sorry, I am not allowed to search the internet.';
    }

    // Add the user's message to the chat history
    messages.push({
      role: 'user',
      content: transcription,
    });

    try {
      const client = axios.create({
        baseURL: process.env.PERPLEXITY_ENDPOINT,
        headers: {
          Authorization: `Bearer ${process.env.PERPLEXITY_API}`,
          'Content-Type': 'application/json',
        },
      });

      // Chat completion without streaming
      const response = await client.post('/chat/completions', {
        model: process.env.PERPLEXITY_MODEL,
        messages: messages,
      });

      const llmresponse = response.data.choices[0].message.content;
      logToConsole(`> LLM Response: ${llmresponse}`, 'info', 1);

      currentlythinking = false;
      return llmresponse;
    } catch (error) {
      currentlythinking = false;
      logToConsole(
        `X Failed to communicate with LLM: ${error.message}`,
        'error',
        1,
      );
      return 'Sorry, I am having trouble processing your request right now.';
    }
  }

  let audioqueue = [];

  async function sendToTTS(text, userid, connection, channel) {
    const words = text.split(' ');
    const maxChunkSize = 120; // Maximum words per chunk
    const punctuationMarks = ['.', '!', '?', ';', ':']; // Punctuation marks to look for
    const chunks = [];
  
    for (let i = 0; i < words.length; ) {
      let end = Math.min(i + maxChunkSize, words.length); // Find the initial end of the chunk
  
      // If the initial end is not the end of the text, try to find a closer punctuation mark
      if (end < words.length) {
        let lastPunctIndex = -1;
        for (let j = i; j < end; j++) {
          if (punctuationMarks.includes(words[j].slice(-1))) {
            lastPunctIndex = j;
          }
        }
        // If a punctuation mark was found, adjust the end to be after it
        if (lastPunctIndex !== -1) {
          end = lastPunctIndex + 1;
        }
      }
  
      // Create the chunk from i to the new end, then adjust it to start the next chunk
      chunks.push(words.slice(i, end).join(' '));
      i = end;
    }
  
    const audioBuffer = await createAudioBuffer(chunks.join(' '));
  
          // save the audio buffer to a file
    const filename = `./sounds/tts.mp3`;
    fs.writeFileSync(filename, audioBuffer);
    //logToConsole(`> Saved file: ${filename}`, 'info', 1);

    if (process.env.RVC === 'true') {
      await sendToRVC(filename, userid, connection, channel);
      logToConsole('> Sending to RVC...', 'info', 2);
    } else {
      audioqueue.push({ file: filename });
     // logToConsole(`> Pushed file: ${filename}`, 'info', 2);
      //console.log(audioqueue)
      if (audioqueue.length > 0) {
        if (audioqueue.length === 1) {
          logToConsole(`> Audio queue item ${audioqueue.length} of ${audioqueue.length}: ${audioqueue[0].file}`, 'info', 2);
          await playAudioQueue(connection, channel, userid);
        } else {
          try {
            await playAudioQueue(connection, channel, userid);
            logToConsole(`> Audio queue item ${audioqueue.length} of ${audioqueue.length}: ${audioqueue[audioqueue.length - 1].file}`, 'info', 2);
          } catch (error) {
            logToConsole(`Error playing audio item ${audioqueue.length} of ${audioqueue.length}: ${error.message}`, 'error', 2);
          }
        }
      }


    }
  }
  
  async function createAudioBuffer(text) {
    const response = await axios.post(
      process.env.OPENAI_TTS_ENDPOINT + '/v1/audio/speech',
      {
        model: process.env.TTS_MODEL,
        input: text,
        voice: process.env.TTS_VOICE,
        response_format: 'mp3',
        speed: 1.0,
      },
      {
        responseType: 'arraybuffer',
      },
    );
    logToConsole('> Using OpenAI', 'info', 2);
    const audioBuffer = Buffer.from(response.data);
  
    return (audioBuffer);
  }

  async function sendToRVC(file, userid, connection, channel) {
    try {
      logToConsole('> Sending TTS to RVC', 'info', 2);

      let mp3name = file.replace('tts', 'rvc');
      mp3name = mp3name.replace('mp3', 'wav');
      let mp3index = mp3name.split('_')[1].split('.')[0];
      mp3index = parseInt(mp3index);

      // Create an instance of FormData
      const formData = new FormData();

      // Append the file to the form data. Here 'input_file' is the key name used in the form
      formData.append('input_file', fs.createReadStream(file), {
        filename: file,
        contentType: 'audio/mpeg',
      });

      // Configure the Axios request
      const config = {
        method: 'post',
        url:
          process.env.RVC_ENDPOINT +
          '/voice2voice?model_name=' +
          process.env.RVC_MODEL +
          '&index_path=' +
          process.env.RVC_MODEL +
          '&f0up_key=' +
          process.env.RVC_F0 +
          '&f0method=rmvpe&index_rate=' +
          process.env.RVC_INDEX_RATE +
          '&is_half=false&filter_radius=3&resample_sr=0&rms_mix_rate=1&protect=' +
          process.env.RVC_PROTECT,
        headers: {
          ...formData.getHeaders(), // Spread the headers from formData to ensure the correct boundary is set
          accept: 'application/json',
        },
        responseType: 'stream', // This ensures that Axios handles the response as a stream
        data: formData,
      };

      // Send the request using Axios
      axios(config)
        .then(function (response) {
          // Handle the stream response to save it as a file
          const writer = fs.createWriteStream(mp3name);
          response.data.pipe(writer);

          return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
        })
        .then(() => {
          // Delete the original tts file
          fs.unlinkSync(file);

          audioqueue.push({ file: mp3name, index: mp3index });

          if (audioqueue.length === 1) {
            logToConsole('> Playing audio queue', 'info', 2);
            playAudioQueue(connection, channel, userid);
          }
        })
        .catch(function (error) {
          logToConsole(
            `X Failed to send tts to RVC: ${error.message}`,
            'error',
            1,
          );
        });
    } catch (error) {
      currentlythinking = false;
      logToConsole(`X Failed to send tts to RVC: ${error.message}`, 'error', 1);
    }
  }

  //let retryCount = 0;
  //const maxRetries = 5; // Maximum number of retries before giving up

    async function playAudioQueue(connection, channel, userid) {
      while (audioqueue.length > 0) {
        const audio = audioqueue.shift(); // Use shift() instead of [0]
        // Create an audio resource from a local file
        const resource = createAudioResource(audio.file);
        logToConsole(`> Playing audio: ${audio.file}`, 'info', 1);
        await playAudioItem(connection, channel, userid, resource);
        player.on('stateChange', async (oldState, newState) => {
          if (oldState.status === AudioPlayerStatus.Playing && newState.status === AudioPlayerStatus.Idle) {
            try {
              deleteFile(audio.file); // Create a new function to delete files after playback
            } catch (error){
              logToConsole(`X Failed to delete file ${error.message}`, 'error', 1)
            }
            if (audioqueue.length > 0) {
              await playAudioQueue(connection, channel, userid);
            } else {
               currentlythinking = false;
               logToConsole('> Audio queue finished', 'info', 2);
            }
          }
          if (oldState.status === AudioPlayerStatus.Paused && newState.status === AudioPlayerStatus.Playing) {
            connection.subscribe(player)
            player.play (resource)
          }
        })
      }




    }



    async function playAudioItem(connection, channel, userid, resource) {
      try {

        await connection.subscribe(player);
        await player.play(resource);
      } catch (err) {
        logToConsole(`> Error: ${err.message}`, 'error', 1);
      }
    }
    function deleteFile(filename) {
      fs.unlinkSync(filename);
      logToConsole(`> Deleting ${filename}`, 'info', 1);
    }

  async function playSound(connection, sound, volume = 1) {
    // Check if allowwithouttrigger is true, if yes ignore
    if ((allowwithouttrigger || allowwithoutbip) && sound !== 'command') {
      return;
    }
    // Create a stream from the sound file using ffmpeg
    const stream = fs.createReadStream(`./sounds/${sound}.mp3`);
    const ffmpegStream = ffmpeg(stream)
      .audioFilters(`volume=${volume}`)
      .format('opus')
      .on('error', (err) => console.error(err))
      .stream();

    // Create an audio resource from the ffmpeg stream
    const resource = createAudioResource(ffmpegStream);
    const player = createAudioPlayer();

    // Subscribe the connection to the player and play the resource
    player.play(resource);
    connection.subscribe(player);

    player.on('error', (error) =>
      logToConsole(`Error: ${error.message}`, 'error', 1),
    );
    player.on('stateChange', (oldState, newState) => {
      if (newState.status === 'idle') {
        alarmongoing = false;
        //logToConsole('> Finished playing sound.', 'info', 2);
      }
    });
  }


function restartListening(userid, connection, channel) {
    handleRecordingForUser(userid, connection, channel);
  }

  async function seatchAndPlayYouTube(songName, userid, connection, channel) {
    // Check if songName is actually a YouTube URL
    let videoUrl = songName;
    if (!songName.includes('youtube.com')) {
      videoUrl = await searchYouTube(songName);
    }

    if (!videoUrl) {
      // If no video was found, voice it out
      await sendToTTS(
        'Sorry, I could not find the requested song.',
        userid,
        connection,
        channel,
      );
    }

    logToConsole(`> Playing YouTube video: ${videoUrl}`, 'info', 1);

    const stream = ytdl(videoUrl, {
      filter: 'audioonly',
      quality: 'highestaudio',
    });
    const ffmpegStream = ffmpeg(stream)
      .audioFilters(`volume=0.05`)
      .format('opus')
      .on('error', (err) => console.error(err))
      .stream();

    const resource = createAudioResource(ffmpegStream);
    const player = createAudioPlayer();

    player.play(resource);
    connection.subscribe(player);

player.on('unpause', async () => {
  logToConsole('> Unpausing the player.', 'info', 1);
   player.unpause();
});
  }

  function logToConsole(message, level, type) {
    switch (level) {
      case 'info':
        if (process.env.LOG_TYPE >= type) {
          console.info(message);
        }
        break;
      case 'warn':
        if (process.env.LOG_TYPE >= type) {
          console.warn(message);
        }
        break;
      case 'error':
        console.error(message);
        break;
    }
  }

  async function searchYouTube(query) {
    if (
      process.env.YOUTUBE_API === undefined ||
      process.env.YOUTUBE_API === '' ||
      process.env.YOUTUBE_API === 'MY_YOUTUBE_API_KEY'
    ) {
      logToConsole('X YouTube API key is missing', 'error', 1);
      await sendToTTS(
        'Sorry, I do not have access to YouTube. You may add a YouTube API key to add this feature.',
        userid,
        connection,
        channel,
      );
      return null;
    }

    // Try removing unwanted words from the query:
    // If it starts with Hey and have a comma, remove everything before the comma and the comma
    // if it ends with "on" or "in", remove the last word
    const unwantedWords = ['hey', 'on', 'in'];
    const queryWords = query.split(' ');
    if (queryWords[0].toLowerCase() === 'hey' && query.includes(',')) {
      query = query.split(',').slice(1).join(',');
    }
    if (
      unwantedWords.includes(queryWords[queryWords.length - 1].toLowerCase())
    ) {
      query = query.split(' ').slice(0, -1).join(' ');
    }

    logToConsole(`> Searching YouTube for: ${query}`, 'info', 1);

    try {
      // First, search for videos
      const searchRes = await youtube.search.list({
        part: 'snippet',
        q: query,
        maxResults: 5,
        type: 'video',
      });

      const videoIds = searchRes.data.items
        .map((item) => item.id.videoId)
        .join(',');

      // Then, get details of these videos
      const detailsRes = await youtube.videos.list({
        part: 'snippet,contentDetails,statistics',
        id: videoIds,
        key: process.env.YOUTUBE_API_KEY,
      });

      // Filter and sort videos by duration and view count
      const validVideos = detailsRes.data.items.filter((video) => {
        const duration = video.contentDetails.duration;
        return convertDuration(duration) >= 30;
      });

      if (!validVideos.length) return null;
      return `https://www.youtube.com/watch?v=${validVideos[0].id}`;
    } catch (error) {
      console.error('Failed to fetch YouTube data:', error);
      return null;
    }
  }

  function convertDuration(duration) {
    let totalSeconds = 0;
    const matches = duration.match(/(\d+)(?=[MHS])/gi) || [];

    const parts = matches.map((part, i) => {
      if (i === 0) return parseInt(part) * 3600;
      else if (i === 1) return parseInt(part) * 60;
      else return parseInt(part);
    });

    if (parts.length > 0) {
      totalSeconds = parts.reduce((a, b) => a + b);
    }
    return totalSeconds;
  }

  async function setTimer(query, type = 'alarm', userid, connection, channel) {
    // Check for known time units (minutes, seconds, hours) with a number
    const timeUnits = [
      'minutes',
      'minute',
      'seconds',
      'second',
      'hours',
      'hour',
    ];
    const timeUnit = timeUnits.find((unit) => query.includes(unit));
    let timeValue = query.match(/\d+/);

    if (timeUnit && !timeValue) {
      // Time value is maybe in text form. Try to convert it to a number
      const converttable = {
        one: 1,
        two: 2,
        three: 3,
        four: 4,
        five: 5,
        six: 6,
        seven: 7,
        eight: 8,
        nine: 9,
      };

      const timeValueText = query.match(
        /\b(one|two|three|four|five|six|seven|eight|nine)\b/,
      );
      if (timeValueText) {
        timeValue = [converttable[timeValueText[0]]];
      }
    }

    if (!timeUnit || !timeValue) {
      await sendToTTS(
        'Sorry, I could not understand the requested timer.',
        userid,
        connection,
        channel,
      );
      return;
    }

    const time = parseInt(timeValue[0]);
    const ms = timeUnit.includes('minute')
      ? time * 60000
      : timeUnit.includes('second')
        ? time * 1000
        : time * 3600000;
    const endTime = new Date(Date.now() + ms);
    const formattedTime = endTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    });

    await sendToTTS(
      `${type} set for ${time} ${timeUnit}`,
      userid,
      connection,
      channel,
    );
    logToConsole(`> ${type} set for ${time} ${timeUnit}`, 'info', 1);

    const timeoutId = setTimeout(() => {
      alarmongoing = true;
      playSound(connection, type, process.env.ALARM_VOLUME);
      logToConsole('> Timer finished.', 'info', 1);
    }, ms);
    alarms.push({ id: timeoutId, time: formattedTime, type: type });
  }

  function cancelTimer(alarmIndex, userid, connection, channel) {
    const index = parseInt(alarmIndex) - 1;
    if (index < alarms.length) {
      clearTimeout(alarms[index].id);
      logToConsole(
        `> ${alarms[index].type} for ${alarms[index].time} cancelled`,
        'info',
        1,
      );
      sendToTTS(
        `${alarms[index].type} for ${alarms[index].time} cancelled.`,
        userid,
        connection,
        channel,
      );
      // Remove the alarm from the list, reindexing the array
      alarms = alarms.filter((alarm, i) => i !== index);
    } else {
      logToConsole(`X Timer index not found: ${index}`, 'error', 1);
       sendToTTS(
        `I could not find a ${alarms[index].type} for this time.`,
        userid,
        connection,
        channel,
      );
    }
  }

  function listTimers(userid, connection, channel) {
    if (alarms.length > 1) {
       sendToTTS(
        `You have the following: ${alarms.map((alarm, index) => `${alarm.type} ${index + 1} set for ${alarm.time}`).join(', ')}`,
        userid,
        connection,
        channel,
      );
    } else if (alarms.length === 1) {
      sendToTTS(
        `You have a ${alarms[0].type} set for ${alarms[0].time}.`,
        userid,
        connection,
        channel,
      );
    } else {
      sendToTTS('There are no timers set.', userid, connection, channel);
    }
  }

  async function captionImage(imageUrl, userId, connection, channel) {
    if (
      process.env.HUGGING_FACE_API === undefined ||
      process.env.HUGGING_FACE_API === '' ||
      process.env.HUGGING_FACE_API === 'MY_HUGGING_FACE_API_KEY'
    ) {
      logToConsole('X Hugging Face API key is missing', 'error', 1);
      await sendToTTS(
        'Sorry, I do not have access to vision. You may add a Hugging Face API key to add this feature.',
        userId,
        connection,
        channel,
      );
      return;
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUGGING_FACE_API}`,
    };

    try {
      const response = await axios.post(
        process.env.VISION_ENDPOINT + '/' + process.env.VISION_MODEL,
        {
          inputs: {
            url: imageUrl, // Some models might require a different format
          },
        },
        { headers: headers },
      );

      const caption = response.data[0].generated_text;
      currentlythinking = true;
      logToConsole(`> Image caption: ${caption}`, 'info', 1);

      // Send the caption to the LLM
      await sendToLLM(
        '*the user sent the following image in a text channel*: ' + caption,
        userId,
        connection,
        channel,
      );
    } catch (error) {
      logToConsole(`X Failed to caption image: ${error.message}`, 'error', 1);
      await sendToTTS('Sorry, I cannot see the image.', userId, connection, channel);
    }
  }

  function splitMessage(message, limit = 2000) {
    const parts = [];
    let currentPart = '';

    // Split the message by spaces to avoid breaking words
    const words = message.split(' ');

    words.forEach((word) => {
      if (currentPart.length + word.length + 1 > limit) {
        // When adding the next word exceeds the limit, push the current part to the array
        parts.push(currentPart);
        currentPart = '';
      }
      // Add the word to the current part
      currentPart += (currentPart.length > 0 ? ' ' : '') + word;
    });

    // Push the last part
    if (currentPart.length > 0) {
      parts.push(currentPart);
    }

    return parts;
  }

  async function isThreadFromBot(message) {
    if (!message.channel.isThread()) return false;

    const threadParentMessage = await message.channel.fetchStarterMessage();
    if (!threadParentMessage) return false;

    return threadParentMessage.author.id === client.user.id;
  }

  async function scheduleReminder(timestamp, message, userId) {
    // Calculate delay in ms between the current time and the reminder time
    const currentTime = Date.now();
    const reminderTime = timestamp * 1000; // Convert Unix timestamp (seconds) to JavaScript timestamp (milliseconds)
    const delay = reminderTime - currentTime;

    if (delay <= 0) {
      client.users
        .fetch(userId)
        .then((user) =>
          user.send(
            `⏰ You set a reminder in the past, sorry I cannot time travel yet!`,
          ),
        )
        .catch((error) =>
          console.error(`Failed to send reminder: ${error.message}`),
        );
      return;
    }

    // Set a timeout to send the reminder message
    // Optionally, store the timeoutId if you need to clear it later
    return setTimeout(() => {
      // Send the reminder message in DM
      client.users
        .fetch(userId)
        .then((user) => user.send(`⏰ Reminder: ${message}`))
        .catch((error) =>
          console.error(`Failed to send reminder: ${error.message}`),
        );
    }, delay);
  }
  const ID = process.env.DISCORD_ID;
  logToConsole(`Please add the bot to the server /n https://discord.com/oauth2/authorize?client_id=${ID}&permissions=964220516416&scope=bot`)
  client.login(TOKEN);
