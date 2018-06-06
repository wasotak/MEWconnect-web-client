const eccrypto = require('eccrypto');
const ethUtils = require('ethereumjs-util');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const buffer = require('buffer').Buffer;
const io = require("socket.io-client")
const SimplePeer = require("simple-peer")

const MewConnectCommon = require('./MewConnectCommon');
const MewConnectCrypto = require('./MewConnectCrypto');

/**
 *  Primary Web end of a MEW Connect communication channel
 *  Handles the initial actions to setup said connection
 */
class MewConnectInitiator extends MewConnectCommon {
  /**
   * @param uiCommunicatorFunc
   * @param loggingFunc
   * @param additionalLibs
   */
  constructor(uiCommunicatorFunc, loggingFunc, additionalLibs) {
    super(uiCommunicatorFunc, loggingFunc);
    additionalLibs = additionalLibs || {};
    // Check if a WebRTC connection exists before a window/tab is closed or refreshed
    // Destroy the connection if one exists
    if(this.isBrowser){
      window.onunload = window.onbeforeunload = function (e) {
        let _this = this;
        if (!!this.peer && !this.peer.destroyed) {
          _this.rtcDestroy();
        }
      };
    }
    this.p = null;
    this.qrCodeString = null;
    this.socketConnected = false;
    this.connected = false;


    this.io = additionalLibs.io || io;

    this.signals = this.jsonDetails.signals;
    this.rtcEvents = this.jsonDetails.rtc;
    this.version = this.jsonDetails.version;
    this.versions = this.jsonDetails.versions;

    // Library used to facilitate the WebRTC connection and subsequent communications
    this.peer = additionalLibs.wrtc || SimplePeer;
    this.nodeWebRTC = additionalLibs.webRTC || null;

    // Initial (STUN) server set used to initiate a WebRTC connection
    this.stunServers = [
      {url: 'stun:global.stun.twilio.com:3478?transport=udp'}
    ];
    // Initialization of the array to hold the TURN server information if the initial connection attempt fails
    this.turnServers = [];

    // Object with specific methods used in relation to cryptographic operations
      this.mewCrypto = additionalLibs.cryptoImpl || MewConnectCrypto.create()

  }

  /**
   * Returns a boolean indicating whether the socket connection exists and is active
   */
  getSocketConnectionState() {
    return this.socketConnected;
  }

  /**
   * Returns a boolean indicating whether the WebRTC connection exists and is active
   */
  getConnectonState() {
    return this.connected;
  }

  /**
   * Emit/Provide the details used in creating the QR Code
   */
  displayCode(data) {
    this.logger("handshake", data);
    this.socketKey = data;
    let separator = this.jsonDetails.connectionCodeSeparator
    let qrCodeString = this.version + separator + data + separator + this.connId;
    this.qrCodeString = qrCodeString;
    this.applyDatahandlers(JSON.stringify({type: 'codeDisplay', data: qrCodeString}));
    this.uiCommunicator('codeDisplay', qrCodeString);
    this.uiCommunicator('checkNumber', data);
    this.uiCommunicator('ConnectionId', this.connId);
  }

  //////////////// Initialize Communication Process //////////////////////////////

  /**
   * The initial method called to initiate the exchange that can create a WebRTC connection
   */
 async initiatorStart(url) {
    this.keys = this.mewCrypto.prepareKey();
    let toSign = this.mewCrypto.generateMessage();
    this.signed = await this.mewCrypto.signMessage(this.keys.pvt.toString("hex"));
    this.connId = this.mewCrypto.bufferToConnId(this.keys.pub);
    this.displayCode(this.keys.pvt.toString("hex"));
    this.uiCommunicator("signatureCheck", this.signed);
    let options = {
      query: {
        stage: "initiator",
        signed: this.signed,
        message: toSign,
        connId: this.connId
      },
      transports: ['websocket', 'polling', 'flashsocket'],
      secure: true
    };
    this.socketManager = this.io(url, options);
    this.socket = this.socketManager.connect();
    this.initiatorConnect(this.socket);
    // this.signed.then(response => {
    //
    // })
  }

  //////////////// WebSocket Communication Methods and Handlers //////////////////////////////

  /**
   * Setup message handlers for communication with the signal server
   */
  initiatorConnect(socket) {
    console.log("INITIATOR CONNECT"); // todo remove dev item
    this.uiCommunicator("SocketConnectedEvent");

    this.socket.on(this.signals.connect, () => {
      console.log("SOCKET CONNECTED"); // todo remove dev item
      this.socketConnected = true;
      this.applyDatahandlers(JSON.stringify({type: "socketConnected", data: null}));
    });
    // A connection pair exists, create and send WebRTC OFFER
    this.socketOn(this.signals.confirmation, this.sendOffer.bind(this)); // response
    // Handle the WebRTC ANSWER from the opposite (mobile) peer
    this.socketOn(this.signals.answer, this.recieveAnswer.bind(this));
    // Handle Failure due to an attempt to join a connection with two existing endpoints
    this.socketOn(this.signals.confirmationFailedBusy, () => {
      this.uiCommunicator("confirmationFailedBusyEvent");
      this.logger("confirmation Failed: Busy");
    });
    // Handle Failure due to the handshake/ verify details being invalid for the connection ID
    this.socketOn(this.signals.confirmationFailed, () => {
      this.uiCommunicator("confirmationFailedEvent");
      this.logger("confirmation Failed: invalid confirmation");
    });
    // Handle Failure due to no opposing peer existing
    this.socketOn(this.signals.invalidConnection, () => {
      this.uiCommunicator("invalidConnectionEvent"); // should be different error message
      this.logger("confirmation Failed: no opposite peer found");
    });
    // Handle Socket Disconnect Event
    this.socketOn(this.signals.disconnect, (reason) => {
      this.logger(reason);
      this.socketConnected = false;
    });
    // Provide Notice that initial WebRTC connection failed and the fallback method will be used
    this.socketOn(this.signals.attemptingTurn, () => {
      this.logger("TRY TURN CONNECTION");//todo remove dev item
    });
    // Handle Receipt of TURN server details, and begin a WebRTC connection attempt using TURN
    this.socketOn(this.signals.turnToken, data => {
      this.retryViaTurn(data);
    });

    return socket;
  }

  // Wrapper around socket.emit method
  socketEmit(signal, data) {
    this.socket.emit(signal, data);
  }

  // Wrapper around socket.disconnect method
  socketDisconnect() {
    this.socket.disconnect();
  }

  // Wrapper around socket.on listener registration method
  socketOn(signal, func) {
    this.socket.on(signal, func);
  }

///////////////////////////////////////////////////////////////////////////////////////////////

////////////////////////// WebRTC Communication Related ///////////////////////////////////////



//////////////// WebRTC Communication Setup Methods ///////////////////////////////////////////

  /**
   *  Initial Step in beginning the webRTC setup
   */
 async sendOffer(data) {
    if (Reflect.has(data, 'version')) {
      let plainTextVersion = await this.mewCrypto.decrypt(data.version);
      console.log("plainTextVersion", plainTextVersion); // todo remove dev item
      this.peerVersion = plainTextVersion;
      this.uiCommunicator('receiverVersion', plainTextVersion);
      console.log('RECEIVER VERSION:', plainTextVersion); // todo remove dev item
    }
    this.logger('sendOffer', data);
      let options = {
        signalListener: this.initiatorSignalListener,
        webRtcConfig: {
          servers: this.stunServers
        }
      };
      this.initiatorStartRTC(this.socket, options);


  }

  /**
   * creates the WebRTC OFFER.  encrypts the OFFER, and
   * emits it along with the connection ID and STUN/TURN details to the signal server
   */
  initiatorSignalListener(socket, options) {
//TODO encrypt the options object
    return async function offerEmmiter(data) {
      let _this = this;
      let listenerSignal = this.signals.offerSignal;
      this.logger('SIGNAL', JSON.stringify(data));
      let encryptedSend = await this.mewCrypto.encrypt(JSON.stringify(data));
      // console.log("OPTIONS", options); // todo remove dev item
      // let encryptedOptions = await this.mewCrypto.encrypt(JSON.stringify(options));
      _this.socketEmit(listenerSignal, {data: encryptedSend, connId: this.connId/*, options: encryptedOptions*/});
    }
  }

  initiatorSignalListenerOriginal(socket, options) {
//TODO encrypt the options object
    return async function offerEmmiter(data) {
      let _this = this;
      let listenerSignal = this.signals.offerSignal;
      this.logger('SIGNAL', JSON.stringify(data));
      _this.socketEmit(listenerSignal, {data: JSON.stringify(data), connId: this.connId/*, options: encryptedOptions*/});
    }
  }

  async recieveAnswer(data) {
    try {
      let plainTextOffer;
      if(this.versions.indexOf(this.peerVersion) > -1){
        console.log("this.peerVersion 1", this.peerVersion, data); // todo remove dev item
        plainTextOffer = await this.mewCrypto.decrypt(data.data);
      } else {
        if(data.data.iv){
          console.log("this.peerVersion 2", this.peerVersion, data); // todo remove dev item
          plainTextOffer = await this.mewCrypto.decrypt(data.data);

        } else {
          console.log("this.peerVersion 3", this.peerVersion, data); // todo remove dev item
          plainTextOffer = data.data;
        }

      }
      this.rtcRecieveAnswer({data: plainTextOffer});
    } catch (e) {
      console.error(e);
    }
  }

  rtcRecieveAnswer(data) {
    this.p.signal(JSON.parse(data.data));
  }

  /**
   * Initiates one side (initial peer) of the WebRTC connection
   */
  initiatorStartRTC(socket, options) {
    let signalListener, webRtcServers, webRtcConfig;
    webRtcConfig = options.webRtcConfig || {};
    signalListener = options.signalListener(socket, webRtcConfig) || this.initiatorSignalListener(socket, webRtcConfig);
    webRtcServers = webRtcConfig.servers || this.stunServers;

    let simpleOptions = {
      initiator: true,
      trickle: false,
      reconnectTimer: 100,
      iceTransportPolicy: 'relay',
      config: {
        iceServers: webRtcServers
      }
    };

    if(!this.isBrowser && this.nodeWebRTC){
      simpleOptions.wrtc = this.nodeWebRTC;
    }

    this.uiCommunicator("RtcInitiatedEvent");
    this.p = new this.peer(simpleOptions);
    this.p.on(this.rtcEvents.error, this.onError.bind(this));
    this.p.on(this.rtcEvents.connect, this.onConnect.bind(this));
    this.p.on(this.rtcEvents.close, this.onClose.bind(this));
    this.p.on(this.rtcEvents.data, this.onData.bind(this));
    this.p.on(this.rtcEvents.signal, signalListener.bind(this));
  }



  //////////////// WebRTC Communication Event Handlers //////////////////////////////


  /**
   * Emitted when the  webRTC connection is established
   */
  onConnect() {
    this.logger("CONNECT", "ok");
    this.connected = true;
    this.rtcSend({type: "text", data: "From Mobile"});
    this.uiCommunicator("RtcConnectedEvent");
    this.applyDatahandlers(JSON.stringify({type: "rtcConnected", data: null}));
    this.socketEmit(this.signals.rtcConnected, this.socketKey);
    this.socketDisconnect();
  }

  /**
   * Emitted when the data is received via the webRTC connection
   */
  async onData(data) {
    console.log(data); // todo remove dev item
    console.log(data.toString()); // todo remove dev item
    this.logger('DATA RECEIVED', data.toString());
    try {
      let decryptedData;
      if(this.isJSON(data)){
        decryptedData = await this.mewCrypto.decrypt(JSON.parse(data.toString()));
      } else {
        decryptedData = await this.mewCrypto.decrypt(JSON.parse(data.toString()));
      }
      if(this.isJSON(decryptedData)){
        this.applyDatahandlers(JSON.parse(decryptedData));
      } else {
        this.applyDatahandlers(decryptedData);
      }
    } catch (e) {
      console.error(e);
      this.logger("peer2 ERROR: data=", data);
      this.logger("peer2 ERROR: data.toString()=", data.toString())
      // this.applyDatahandlers(data);
    }
  }

  /**
   * Emitted when one end of the webRTC connection closes
   */
  onClose(data) {
    this.logger("WRTC CLOSE");
    this.connected = false;
    this.uiCommunicator("RtcClosedEvent", data);
  }

  /**
   * Emitted when there is an error with the webRTC connection
   */
  onError(err) {
    console.error("WRTC ERROR");
    this.logger("error", err);
  }


///////////////////////////// WebRTC Communication Methods /////////////////////////////////////////
  /**
   * sends a hardcoded message through the rtc connection
   */
  testRTC(msg) {
    return function () {
      let _this = this;
      _this.rtcSend(JSON.stringify({type: 2, text: msg}));
    }.bind(this);
  }

  /**
   * prepare a message to send through the rtc connection. using a closure to hold off calling the rtc object until after it is created
   */
  sendRtcMessageClosure(type, msg) {

    return function () {
      let _this = this;
      _this.rtcSend(JSON.stringify({type: type, data: msg}));
    }.bind(this);
  }

  /**
   * prepare a message to send through the rtc connection
   */
  sendRtcMessage(type, msg) {
    this.rtcSend(JSON.stringify({type: type, data: msg}));
  }

  /**
   * Disconnect the current RTC connection
   */
  disconnectRTCClosure() {
    let _this = this;
    return function () {
      _this.uiCommunicator("RtcDisconnectEvent");
      _this.applyDatahandlers(JSON.stringify({type: "rtcDisconnect", data: null}));
      _this.rtcDestroy();
      this.instance = null;
    }.bind(this);
  }

  /**
   * Disconnect the current RTC connection, and call any clean up methods
   */
  disconnectRTC() {
    this.uiCommunicator("RtcDisconnectEvent");
    this.applyDatahandlers(JSON.stringify({type: "rtcDisconnect", data: null}));
    this.rtcDestroy();
    this.instance = null;
  }

  /**
   * send a message through the rtc connection
   */
  async rtcSend(arg) {
    let encryptedSend;
    if (typeof arg === 'string') {
      encryptedSend = await this.mewCrypto.encrypt(arg);
      // this.p.send(arg);
    } else {
      encryptedSend = await this.mewCrypto.encrypt(JSON.stringify(arg));
      // this.p.send(JSON.stringify(arg));
    }
    this.p.send(JSON.stringify(encryptedSend));
  }

  /**
   * Disconnect/Destroy the current RTC connection
   */
  rtcDestroy() {
    this.p.destroy();
  }


  //////////////// WebRTC Communication TURN Fallback Initiator/Handler ///////////////////////////
  /**
   * Fallback Step if initial webRTC connection attempt fails.
   * Retries setting up the WebRTC connection using TURN
   */
  retryViaTurn(data) {
    let options = {
      signalListener: this.initiatorSignalListener,
      webRtcConfig: {
        servers: data.data
      }
    };
    this.initiatorStartRTC(this.socket, options);
  }

}


module.exports = MewConnectInitiator