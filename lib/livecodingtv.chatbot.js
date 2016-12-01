/*jslint node: true es5: true nomen: true*/
/*globals Promise*/
var Xmpp = require('node-xmpp-client'),
    ltx = require('node-xmpp-core').ltx,
    util = require('util'),
    fs = require('fs'),
    events = require('events'),
    extend = require('extend');
(function () {
    "use strict";
    
    /******************************************************
    * Methods:
    *   viewers = array of all moderators and viewers present
    *   moderators = array of all moderators present
    *   owner = string of channel owner / room
    *   say(String message) = broadcast message to the feed
    *   from(object stanza) = string of the stanza object sender name
    *   role(string who) = string of the viewer’s role ["owner"|"moderator"|"viewer"|"guest"]
    *   join([room]) = Joins the room requested, if no room requested, joins the JID’s room
    *   connectToServer = initializes the connection to Livecoding.tv
    *
    * Events:
    *   on('connected')
    *   on('disconnected')
    *   on('error', OBJECT|STRING)
    *   on('online')
    *   on('offline')
    *   on('join', { who: STRING, role: ["owner"|"moderator"|"viewer"|"guest"]})
    *   on('leave', { who: STRING, role: ["owner"|"moderator"|"viewer"|"guest"]})
    *   on('message', { from: STRING, role: ["owner"|"moderator"|"viewer"|"guest"], message: STRING, stanza: OBJECT })
    *
    ******************************************************/
    var ChatBot = function (supplied_config) {
                
        this.server = null;
        this.streamer = {};
        
        var self = this, LiveCodingTV,
            
            // This object will be merged with the one supplied in the creation of the object.
            config = {
                jid : null,
                password : null,
                domain : 'livecoding.tv',
                chatDomain : 'chat.livecoding.tv',
                trackGuests : false,
                widgetDir : __dirname + '/../widgets/active/'
            },
            
            hasInit = false,
            
            // Enabling the ability to track the current users within the channel based upon their status
            channel = {
                name : null,
                owner : null,
                mods : [],
                viewers : [],
                guests : [],
                fav: false
            },
            
            stanzaError = function (stanza) {
                self.emit('error', stanza);
            },

            connected = function () {
                self.emit('connected');
            },

            disconnected = function (e) {
                self.emit('disconnected');
            },

            isOffline = function () {
                self.emit('offline');
            },

            errored = function (err) {
                self.emit('error', err);
                console.log(JSON.stringify(err));
            },

            isOnline = function () {
                self.emit('online');
            },
        
            // Before doing anything, check to see if the message is a command with a prefix “!”
            applyCommands = function (data) {
                return new Promise((resolve, reject) => {
                    var cmd = false;

                    if (data.message.indexOf('!') === 0) {
                        if (data.message.indexOf(':') === -1) {
                            cmd = data.message = data.message.substring(1).toLowerCase();
                        } else {
                            cmd = data.message.substring(1, data.message.indexOf(':')).toLowerCase();
                        }
                    }
                    if (LiveCodingTV.commands[cmd]) {
                        LiveCodingTV.commands[cmd](data);
                        resolve(false);
                    } else { resolve(data); }
                });
            },

            emitMessage = function (data) {
                if (data) {
                    self.emit('message', data);
                }
            },

            // Upon receiving message, process it only if there is no delay elements (past message)
            // and the from is not the chatbot username
            receiveMessage = function (stanza) {
                try {
                    var message = stanza.getChild('body').children.toString(),
                    from = self.from(stanza);
                    if (!stanza.getChild('delay')) {
                        applyCommands({
                            from: from,
                            role: self.role(from),
                            message: message,
                            stanza : stanza
                        }).then(emitMessage);
                    }
                } catch (e) {
                    console.log('error receiving message');
                }
            },
            
            // Capture any new presence as a what their role is. Anybody who leaves, simply
            // remove them from the channel object variable
            newPresence = function (stanza) {
                var index, who = self.from(stanza),
                    affiliation = stanza.getChild('x').getChild('item').attrs.affiliation;
                if (typeof stanza.attrs.type !== 'undefined' && stanza.attrs.type === 'unavailable') {
                    self.emit('leave', {
                        who : who,
                        role: self.role(who)
                    });
                    index = channel.viewers.indexOf(who);
                    if (index > -1) { channel.viewers.splice(index, 1); }
                    index = channel.mods.indexOf(who);
                    if (index > -1) { channel.mods.splice(index, 1); }
                    index = channel.guests.indexOf(who);
                    if (index > -1) { channel.guests.splice(index, 1); }
                } else {
                    switch (affiliation) {
                    case "owner":
                        channel.owner = who;
                        if (!stanza.getChild('delay')) {
                            self.emit('join', { who: who, role: 'owner'});
                        }
                        break;
                    case "admin":
                        if (channel.mods.indexOf(who) === -1) {
                            channel.mods.push(who);
                            if (!stanza.getChild('delay')) {
                                self.emit('join', { who: who, role: 'moderator'});
                            }
                        }
                        break;
                    default:
                        if (who.toLowerCase().indexOf('guest__') === 0) {
                            if (config.trackGuests === true) {
                                if (channel.guests.indexOf(who) === -1) {
                                    channel.guests.push(who);
                                    self.emit('join', { who: who, role: 'guest'});
                                }
                            }
                        } else if (channel.viewers.indexOf(who) === -1) {
                            channel.viewers.push(who);
                            if (!stanza.getChild('delay')) {
                                self.emit('join', { who: who, role: 'viewer'});
                            }
                        }
                    }
                }
            },
            
            // Any new stanza message coming into the app will be parsed as 3 various types
            receiveStanza = function (stanza) {
                switch (stanza.name) {
                case "error":
                    stanzaError(stanza);
                    break;
                case "message":
                    receiveMessage(stanza);
                    break;
                case "presence":
                    newPresence(stanza);
                    break;
                }
            },
            
            load_external_widgets = function () {
                var widgets = fs.readdir(config.widgetDir, (err, files) => {
                    if (err) throw err;
                    
                    files.forEach(f => {
                        if (f.indexOf('lctv_widget') === 0) {
                            LiveCodingTV.commands[f.split('.')[1]] = require(config.widgetDir + f)(self);
                            console.log("Installed widget:", f.split('.')[1]);
                        }
                    });
                });
            },
        
            // Only begin listening to various events upon server being initialized
            initListeners = function () {
                return new Promise(function (resolve, reject) {
                    self.server.on('stanza', receiveStanza);
                    self.server.on('connect', connected);
                    self.server.on('disconnect', disconnected);
                    self.server.on('online', isOnline);
                    self.server.on('offline', isOffline);
                    self.server.on('error', errored);
                    resolve();
                });
            };

        this.me = function () {
            return config.jid;
        };
        // Return a list of all viewers who are not the owner
        this.viewers = function () {
            return channel.mods.concat(channel.viewers);
        };
        
        // Return a list of all moderators
        this.moderators = this.mods = function () {
            return channel.mods;
        };
        
        // Return the owner of the channel
        this.owner = function () {
            return channel.name;
        };
        
        this.favourite = function (who) {
            who = who || false;
            if (who) {
                channel.fav = who;
            } else {
                return channel.fav;
            }
        };
        
        // Send a message out to the chat
        this.say = function (message) {
            return new Promise((resolve, reject) => {
                var stanza = new ltx.Element('message', {to: channel.name + '@' + config.chatDomain, type: 'groupchat'});
                self.server.send(stanza.c('body').t(message));
                resolve();
            });
        };
        
        // Capture the from name of a stanza object
        this.from = function (stanza) {
            return stanza.attrs.from
                .substring(stanza.attrs.from.indexOf('/') + 1);
        };
        
        // Capture the role of a specific user
        this.role = function (who) {
            if (channel.owner === who) {
                return "owner";
            } else if (channel.mods.indexOf(who) !== -1) {
                return "moderator";
            } else if (who.toLowerCase().indexOf('guest__') || channel.guests.indexOf(who) !== -1) {
                return "guest";
            } else {
                return "viewer";
            }
        };
        
        // Join a room specified or the room of the JID if none provided
        this.join = function (room) {
            return new Promise((resolve, reject) => {
                channel.name = room || config.jid;
                self.server.send(new ltx.Element('presence', { to : channel.name + '@' + config.chatDomain + '/' + config.jid}).c('x', {xmlns: 'http://jabber.org/protocol/muc'}));
                resolve();
            });
        };
        
        this.connectToServer = function () {
            return new Promise((resolve, reject) => {
                if (config.jid && config.password) {
                    self.server = new Xmpp.Client({
                        jid     : config.jid + '@' + config.domain,
                        password: config.password,
                        reconnect: true
                    });
                    self.server.connection.socket.setTimeout(0);
                    self.server.connection.socket.setKeepAlive(true, 10000);
                    initListeners()
                        .then(resolve);
                } else {
                    console.log('Invalid JID and Password');
                    reject('No JID or Password set');
                }
            });
        };
        
        this.init = function () {
            return new Promise((resolve, reject) => {
                if (hasInit) {
                    resolve();
                    return;
                }
                hasInit = true;
                if (supplied_config && typeof supplied_config === "object") {
                    extend(config, supplied_config);
                }
                load_external_widgets();
            });
        };
        
        LiveCodingTV = module.parent.exports;
        
        this.init();
    };
    
    util.inherits(ChatBot, events.EventEmitter);
    
    module.exports = ChatBot;
    
}());