
const fetch = require('node-fetch');
var moment = require('moment-timezone');
const fs = require('fs')
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;

class P4Handler {
    constructor(P4_PASSWD,P4_USER,P4_PORT,SAVE_FILE,CRON_TIMEZONE,DISCORD_URL) {
        this.P4_PASSWD = P4_PASSWD;
        this.P4_USER = P4_USER;
        this.P4_PORT = P4_PORT;
        this.LoggedIn = false;
        this.LoginCheck = true;
        this.P4Data = {
            last_update: null,
            update_num: 0,
            updates: []
        };
        this.CRON_TIMEZONE = CRON_TIMEZONE;
        this.SAVE_FILE = SAVE_FILE;
        this.WEBHOOK_URL = DISCORD_URL;
        moment().tz(this.CRON_TIMEZONE).format();
    }
    p4setconfig(name,value) {
        return new Promise((res, rej) => {
            var cmd = spawn(`p4`,['set',`${name}=${value}`]);
            cmd.on('close', () => {
                return res();
            })
            cmd.on('error', () => {
                return rej();
            })
        });
    }
    p4login() {
        return new Promise((res, rej) => {
            var cmd = spawn('p4',['login']);
            cmd.stdin.write(this.P4_PASSWD);
            cmd.stdout.on('data', function (data) {
                let arr = data.toString().split(/\s/);
                if (data.toString().match(/([uU]ser)\s[a-zA-Z0-9]{1,}\s([lL]ogged)\s([iI]n)/gi)) {
                    console.log(`\tAuthenticated with Perforce Server`)
                }
            });
            cmd.stdin.end();
            cmd.on('close', () => {
                this.LoggedIn = true;
                return res();
            })
            cmd.on('error', () => {
                return rej();
            })
        });
    }
    p4trust() {
        return new Promise((res, rej) => {
            var cmd = spawn('p4',['trust']);
            cmd.stdin.write("yes");
            cmd.stdout.on('data', function (data) {
                let arr = data.toString().split(/\s/);
                if (data.toString().match(/(Added)\strust\sfor\sP4PORT/gi)) {
                    console.log(`\tAdded Trust for the stored P4PORT`)
                }
            });
            cmd.stdin.end();
            cmd.on('close', () => {
                return res();
            })
            cmd.on('error', () => {
                return rej();
            })
        });
    }
    p4check() {
        return new Promise((res, rej) => {
            var cmd = spawn(`p4`,['changes','-t','-m','1','-l']);
            var payload = null;
            cmd.stdout.on('data', function (data) {
                let arr = data.toString().split(/[\r\n]/g).filter(function (x) { return (x.length > 0) })
                let change = arr.shift().split(/\s+/g)
                payload = {
                    data: change,
                    message: arr.join("\n")
                };
            });
            cmd.on('close', () => {
                return res(payload);
            })
            cmd.on('error', () => {
                return rej();
            })
        });
    }
    p4parse(changes) {
        let user = changes.data[6].split("@");
        var obj = {
            type: changes.data[0],
            num: changes.data[1],
            timestamp: moment(`${changes.data[3]} ${changes.data[4]}`, "YYYY/MM/DD hh:mm:ss"),
            user: user[0],
            workspace: user[1],
            reason: changes.message
        }
        return obj;
    }
    login() {
        return Promise.all([this.p4setconfig("P4USER", this.P4_USER),this.p4setconfig("P4PORT", this.P4_PORT)]).then(() => {
            return this.p4trust().then(() => {
                return this.p4login().then(() => {
                    this.LoginCheck = false;
                });
            });
        })
    }
    writeFile(file, data) {
        return new Promise((res, rej) => {
            fs.writeFile(file, data, 'utf8', function (err) {
                if (err) return rej(err);
                else return res();
            });
        })
    }
    sendWebhook(obj) {
        return fetch(this.WEBHOOK_URL, {
            "method":"POST",
            "headers": {
                "Content-Type": "application/json"
            },
            "body": JSON.stringify({
                "content": null,
                "embeds": [
                  {
                    "title": `Current Status Update`,
                    "description": `**Description**\n${obj.reason}`,
                    "color": 5004026,
                    "author": {
                      "name": obj.user
                    },
                    "footer": {
                      "text": "Perforce Discord Webhook"
                    },
                    "timestamp": obj.timestamp,
                    "fields": [
                      {
                        "name": "Type",
                        "value": obj.type,
                        "inline": true
                      },
                      {
                        "name": "Push #",
                        "value": obj.num,
                        "inline": true
                      }
                    ]
                  }
                ]
              })
        
           });
    }
    loadConfig() {
        return new Promise((res, rej) => {
            fs.access(this.SAVE_FILE, fs.F_OK, (err) => {
                if (err) {
                    console.error("P4Data file does not exist..\n\tCreating now.")
                    this.writeFile(this.SAVE_FILE, JSON.stringify(this.P4Data, null, 2)).then(() => {
                        console.log(`File(${this.SAVE_FILE}) was created successfully.`);
                        return res();
                    }).catch((err) => {
                        return rej(err);
                    });
                } else {
                    console.log("P4Data file was Loaded!")
                    this.P4Data = require(this.SAVE_FILE);
                    return res();
                }
            })
        });
    }
    updateCheck() {
        return this.p4check().then((changes) => {
            var obj = this.p4parse(changes);
            if (obj.num > this.P4Data.update_num) {
                this.P4Data.update_num = obj.num;
                this.P4Data.last_update = obj.timestamp;
                this.P4Data.updates.push(obj)
                return this.writeFile(this.SAVE_FILE, JSON.stringify(this.P4Data, null, 2)).then(() => {
                    return this.sendWebhook(obj).then(() => {
                        return true;
                    });
                });
            } else {
                return false;
            }
        }).catch((err) => {
            console.error(`Cron Check Err: ${err}`);
            this.LoginCheck = true;
        })
    } 
    runCron() {
        if (this.LoggedIn) {
            if (!this.LoginCheck) {
                return this.updateCheck();
            } else {
                return this.login().then(() => {
                    return this.updateCheck();
                });
            }
        } else {
            return new Promise((res, rej) => { return res(false) });
        }
    }
}

module.exports = P4Handler;