var mqtt = require('mqtt')
var noble = require('noble');
var program = require('commander');
var log4js = require('log4js');
var logger = log4js.getLogger();

var DEFAULT_TOPIC = 'peca/'

logger.level = 'warn';

program
    .version('0.1.0')
    .usage('[options] <device name>')
    .option('-H --host <host>', 'hostname of MQTT')
    .option('-p --port <port>', 'port of MQTT')
    .option('-u --username <username>', 'username for the broker')
    .option('-P --password <password>', 'password for the broker')
    .option('-t --topic <topic>', 'Base topic name(default: ' + DEFAULT_TOPIC + ')')
    .option('-v --verbose', 'verbose mode')
    .option('-d --debug', 'debug mode')
    .parse(process.argv);

if(program.args.length == 0) {
    console.log('Device name missing!');
    program.help();
}
if(program.debug) {
    logger.level = 'debug';
}else if(program.verbose) {
    logger.level = 'info';
}
var deviceName = program.args[0];
logger.info('Expected: ' + deviceName);
var topicBase = program.topic ? program.topic : DEFAULT_TOPIC;

var host = program.host ? program.host : 'localhost';
var port = program.port ? program.port : 1883;
logger.debug('Connecting broker ' + host + ':' + port);

var options = new Object();
if(program.username) {
    options['username'] = program.username;
}
if(program.password) {
    options['password'] = program.password;
}
var client  = mqtt.connect('mqtt://' + host + ':' + port, options);

client.on('connect', function () {
    logger.info('Connected');
    connectedClient = client;
    _updateConnection();
    client.subscribe(topicBase + '#')
});

var connectedClient = null;
var poweredNoble = null;
var isScanning = false;
var activePeca = null;

noble.on('stateChange', function(state) {
    logger.info('stateChange: ' + state);
    if (state === 'poweredOn') {
        poweredNoble = noble;
    }else{
        poweredNoble = null;
        isScanning = false;
        noble.stopScanning();
    }
    _updateConnection();
});

function _updateConnection() {
    if(connectedClient && poweredNoble) {
        logger.info('Start scanning...');
        isScanning = true;
        poweredNoble.startScanning();
    }
}

function _resetConnection() {
    activePeca = null;
    _updateConnection();
}

noble.on('discover', function(peripheral) {
    logger.info('peripheral with UUID ' + peripheral.uuid + ' found'); 
    var advertisement = peripheral.advertisement; 
    var localName = advertisement.localName; 
    if (localName) { 
        logger.debug('Local Name = ' + localName);
        if (localName != deviceName) {
            logger.info('Ignore device: ' + localName);
            return;
        }
    }else{
        logger.debug('Local Name not defined');
        return;
    }
    poweredNoble.stopScanning();
    isScanning = false;

    activePeca = new Peca(localName, peripheral, connectedClient);
    activePeca.start();
});


function Peca(localName, peripheral, mqttClient) {
    var self = this;

    self.localName = localName;
    self.peripheral = peripheral;
    self.mqttClient = mqttClient;
    self.characteristics = null;
    self.lastStatus = null;
    self.isConnected = false;
    self.commands = [];
    self.disconnectTimer = null;

    self.getTopicBase = function() {
        return topicBase + self.localName;
    };

    self.start = function() {
        self._connect(function(characteristics) {
            var msg = {'status': 'added', 'topic': {'led': self.getTopicBase() + '/led'}, 'name': self.localName};
            self.mqttClient.publish(self.getTopicBase(), JSON.stringify(msg));

            self.isConnected = true;
            self._flushCommands();
        }, function() {
            self.isConnected = false;
        });
    };

    self._connect = function(successHandler, disconnectHandler) {
        logger.info('Connecting...');
        self.peripheral.once('disconnect', function() {
            logger.info('Disconnected');
            if(disconnectHandler) {
                disconnectHandler();
            }
        });
        self.peripheral.connect(function(error){
            if(error) {
                logger.warn('connect error: ' + error);
                _resetConnection();
                return;
            }
            logger.info('connected to ' + peripheral.uuid);

            self.peripheral.discoverServices(['713d0000503e4c75ba943148f18d941e'], function (error, services){
                if(error) {
                    logger.error('discoverServices error: ' + error);
                    _resetConnection();
                    return;
                }
                if(services.length == 0) {
                    logger.error('discoverServices error: ' + 'services not found');
                    _resetConnection();
                    return;
                }

                logger.debug('services.length: ' + services.length);

                var pecaService = services[0];
                pecaService.discoverCharacteristics(['713d0003503e4c75ba943148f18d941e'], function(error, characteristics){
                    if(error) logger.warn('discoverCharacteristics error: ' + error);
                    logger.debug('characteristics.length: ' + characteristics.length);

                    self.characteristics = characteristics;
                    if(successHandler) {
                        successHandler(characteristics);
                    }
                    self._refreshDisconnectTimer();
                });
            });
        });
    };

    self._refreshDisconnectTimer = function() {
        if(self.disconnectTimer != null) {
            clearTimeout(self.disconnectTimer);
        }
        self.disconnectTimer = setTimeout(function() {
            logger.info('Device is idle, disconnecting...');
            self.peripheral.disconnect();
            self.disconnectTimer = null;
        }, 1000 * 60);
    };

    self.receiveLEDMessage = function(message) {
        if(self.lastStatus !== null && message['on'] == self.lastStatus) {
            logger.info('Nothing to do. Ignored.');
            return;
        }
        self.commands.push(message);
        if(self.isConnected) {
            self._flushCommands();
        }else{
            self._connect(function(characteristics) {
                self.isConnected = true;
                self._flushCommands();
            }, function() {
                self.isConnected = false;
            });
        }
    };

    self._flushCommands = function() {
        self.commands.forEach(self._publishLEDMessage);
        self.commands = [];

        self._refreshDisconnectTimer();
    };

    self._publishLEDMessage = function(message) {
        logger.debug(message);
        if(self.characteristics) {
            if(message['on'] == true) {
                logger.info('LED on');
                if(self.lastStatus != true) {
                    logger.debug('Write');
                    // Power on during 10 minutes
                    self.characteristics[0].write(new Buffer([0x02, 0x0a]), true);
                    self.lastStatus = true;
                }
            }else{
                logger.info('LED off');
                if(self.lastStatus != false) {
                    logger.debug('Write');
                    self.characteristics[0].write(new Buffer([0x01, 0x00]), true);
                    self.lastStatus = false;
                }
            }
        }
    };
}

 
client.on('message', function (topic, message) {
    logger.debug(topic + ': ' + message.toString())
    if(activePeca) {
        if(topic == activePeca.getTopicBase() + '/led') {
            try {
                activePeca.receiveLEDMessage(JSON.parse(message.toString()));
            }catch(e){
                logger.warn(e);
            }
        }
    }
});

noble.on('warning', function(message) {
    logger.warn(message);
});
