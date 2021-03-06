var pinoccio = require('pinoccio')
var Emitter = require("events").EventEmitter;
var util = require('util');

// there are more pins but they are already connected to a bunch of cool things.
// im not sure the right way to manage it. io.led?
// https://github.com/Pinoccio/core-pinoccio/blob/master/avr/variants/pinoccio/pins_arduino.h
var pins = [
  { id: "D0", modes: [-2] }, //always reserved
  { id: "D1", modes: [-2] }, //always reserved
  { id: "D2", modes: [0, 1, 3, 4] },
  { id: "D3", modes: [0, 1, 3, 4] },
  { id: "D4", modes: [0, 1, 3, 4] },
  { id: "D5", modes: [0, 1, 3, 4] },
  { id: "D6", modes: [0, 1] }, // reserved on lead scout. sdcard 
  { id: "D7", modes: [0, 1] }, // reserved on lead scout. wifi
  { id: "D8", modes: [0, 1] }, // reserved on lead scout. wifi
  { id: "A0", modes: [0, 1, 2] },
  { id: "A1", modes: [0, 1, 2] },
  { id: "A2", modes: [0, 1, 2] },
  { id: "A3", modes: [0, 1, 2] },
  { id: "A4", modes: [0, 1, 2] },
  { id: "A5", modes: [0, 1, 2] },
  { id: "A6", modes: [0, 1, 2] },
  { id: "A7", modes: [0, 1, 2] }
];

// 
//                 -2           -1         0        1         2       3
//var pinModes = ['reserved', 'disabled', 'float', 'output', 'input', 'pwm'];

var publicModes = {
  INPUT: 0,
  OUTPUT: 1,
  ANALOG: 2,
  PWM: 3,
  SERVO: 4
}

var internalModes = {
  RESERVED:-2, // pinoccio
  DISABLED:-1, // pinoccio 
  FLOAT:0, // pinoccio 
  INPUT: 2,
  OUTPUT: 1,
  ANALOG:0, 
  PWM: 3,
  SERVO: 4 // todo
};

var modeMap = translate(publicModes,internalModes) 
var internalModeMap = translate(internalModes,publicModes) 

module.exports = PinoccioIO;

function PinoccioIO(opts){

  if (!(this instanceof PinoccioIO)) {
    return new PinoccioIO(opts);
  }
  var z = this;
 
  Emitter.call(z);

  z._api = pinoccio(opts);

  z.troop = opts.troop;
  z.scout = opts.scout;

  z._api.rest({url:'v1/'+opts.troop+'/'+opts.scout},function(err,data){

    if(err) {
      console.error(err);
      return z.emit('error',err);
    }

    if(!data) {
      console.error(err);
      return z.emit('error',new Error('unknown troop or scout'));
    }


    z.sync = z._api.sync({stale:1});

    // make sure we get a fresh pin report. edge case where a report may be missing.
    z.command("pin.digital.report;pin.analog.report;",function(err,res){
      if(err) console.error('error sending pin report command ',err);
    })

    z.data = {};// sync data object.

    // board is ready after i get  available && digital && analog events.
    // TODO FIND GREAT Way to message when a scout may be off / unavailable 
    var isReady = function(){
      return !z.isReady && (z.data.available && z.data.available.available) && z.data.digital && z.data.analog; 
    };

    z.emit('connect');

    var delay;
  
    z.sync.on('data',function(data){

      // i care about 3 api events
      //
      // available: {"scout":1,"available":1,"reply":"11\n","_t":1399594464252,"type":"available"}
      // digital:   {"type":"digital","mode":[-1,-1,-1,-1,2,-1,-1],"state":[-1,-1,-1,-1,0,-1,-1],"_t":1396672122237}
      // analog:    {"type":"analog","mode":[-1,-1,-1,-1,-1,-1,-1,-1],"state":[-1,-1,-1,-1,-1,-1,-1,-1],"_t":1396651237836}
      //
      data = data.data;
      
      if(data.account && data.troop == z.troop && data.scout == z.scout && data.type) {

        clearTimeout(delay);

        var key = data.type
        z.data[key] = data.value||data;
        
        if(key == 'digital' || key == 'analog') {
          var offset = key == 'analog'?9:2;
          var report = data.value;
          var skew = key == 'digital'?2:0;

          //console.log('report',report);

          report.mode.forEach(function(mode,i){
            
            // mode may be undefined if the pin becomes disabled because this is not a state understood by the j5 interface
            mode = internalModeMap[mode];//

            var value = report.state[i];
            var pin = z.pins[offset+i];
            var change = false;

            if(mode != pin.mode) {
              change = true;
              pin.mode = mode;
            } 

            if(value != pin.value) {
              change = true;
              pin.value = value;
            } 

            if(z.isReady && change) {
              z.emit(key+'-pin-'+(i+offset),value);
            }
          });

        }

        if(isReady()) {
          // completely ready...
          z.isReady = true;
          z.emit('ready');
        }

      }
    }).on('error',function(err){
      z.emit('error',err);
    });

  }); 

  z.pins = pins.map(function(pin,i) {
    return {
      id:pin.id,
      supportedModes: pin.modes,
      mode: -1, // disabled. waiting for push from api.
      value: 0,
      report:1,// all pins report
      analogChannel:i>=9?i-9:127
    };  
  }); 

  this.analogPins = this.pins.slice(9).map(function(pin, i) {
    return i+9;
  }); 

}

util.inherits(PinoccioIO.prototype,Emitter);
PinoccioIO.prototype = new Emitter;

mix(PinoccioIO.prototype,{
  name:"pinoccio-io",
  isReady:false,
  HIGH:1,
  LOW:0,
  MODES:publicModes,
  pins:[],
  // handle to api.
  _api:false,
  // placeholder for setSamplingInterval
  _interval:19,
  defaultLed:'@led',
  pinMode:function(pin,mode){

    var p = pinType(pin,'digital');

    // short circuit for psuedo pins 
    if(p.type === '@') return this;

    if(!this.pins[p.i]) return false;// throw?

    if(this.pins[p.i].mode === mode) return this;

    this.pins[p.i].mode = mode;

    mode = modeMap[mode];

    this.command('pin.setmode("'+p.pin+'",'+mode+')',function(err){
      if(err) console.log('pin setmode error ',p.pin,mode,err);
    });

    return this;
  },
  digitalWrite:function(pin,value){
    
    var p = pinType(pin,'digital');

    if(p.type === '@') {
      if(p.pin === '@led'){
        this.command('led.'+(value == this.LOW?'on':'off'),function(err){
          if(err) console.error('error setting led');
        }) 
      }
      return this;
    }

    return this._pinWrite(p,value);
  },
  analogWrite:function(pin,value){

    var p = pinType(pin,'analog');
    if(p.type === '@') return this;
    // based on http://arduino.cc/en/Reference/AnalogWrite shouldn't the pin default to digital?
    // just copying the default behavior from spark-io. TODO check j5 examples
    return this._pinWrite(p,value);
  },
  digitalRead:function(pin,handler){

    var p = pinType(pin,'digital');
    if(p.type === '@') return this;

    return this._pinRead(p,handler);
  },
  analogRead:function(pin,handler){

    var p = pinType(pin,'analog');
    if(p.type === '@') return this;

    return this._pinRead(p,handler);
  },
  setSamplingInterval:function(analogInterval,digitalInterval,peripheralInterval,cb) {
    // this sets the analog sampling interval.
    // right now it also resets the digital and peripheral sampling intervals.
    analogInterval = safeInt(analogInterval||1000);
    digitalInterval = safeInt(digitalInterval||50,50);
    peripheralInterval = safeInt(peripheralInterval||60000);

    // polling reporting interval.
    // events.setCycle(digtialEvents (default is 50ms),analogEvents (default is 1000ms),peripheral sampling interval (temp battery etc default 60000ms))
    var z = this;
    z.command("events.setCycle("+digitalInterval+","+analogInterval+","+peripheralInterval+");",function(err,data){
      if(err) z.emit('command-error',err)
      if(cb) cb(err,data);
      else console.error('error setting sampling interval. ',err);
    });

    return this;
  },
  reset:function() {
    // whats this supposed to do.
    return this;
  },
  close:function() {
    if(this.sync) this.sync.end();
    // it seems like i should do these things
    //this.isReady = false;
    //this.emit('close');
  },
  // its kinda a noop right now. just return the pin int which gets changed into the pin str again before being added to scout script
  // add normalize re https://github.com/rwaldron/johnny-five/issues/345
  normalize:function(pin){
    return pinType(pin).i;
  },
  _pinWrite:function(data,value){

    value = +value;
    if(isNaN(value)) return false;
    this.command('pin.write("'+data.pin+'",'+value+')',function(err,data){
      if(err) console.error('error writing pin ',data,value,err);
    }); 
      
  },
  _pinRead:function(data,handler){
    // expect pin as string
    this.on(data.name+'-pin-'+data.i,handler);
    return this;
  },
  // pinoccio only.
  // send scout script command directly to the scout.
  command:function(command,cb){
    var z = this;
    z._api.rest({url:'/v1/'+this.troop+'/'+this.scout+'/command',data:{command:command}},function(err,data){
      cb(err,data);
    });
  },
});

PinoccioIO.prototype.servoWrite = PinoccioIO.prototype.analogWrite;

function safeInt(interval,min,max){
  min = min||100;
  max = max||65535;
  return interval < min ?
    min : (interval > max ? max : interval);
}

function pinType(pin,type){

  var t = type == 'analog'?'a':'d';
  if(typeof pin == 'number'){
    if(pin >= 9){
      t = 'a';
      pin -= 9;
    }
    pin = t+pin;
  }

  if(pin.indexOf('@') == 0){
    //special @led etc
    return {pin:pin.toLowerCase(),type:'@',i:-1};
  }

  pinInt = (pin.replace(/A|D/i, "") | 0) + (t == 'a' ? 9 : 0);

  return {pin:pin.toLowerCase(),type:t,name:type,i:pinInt};
}


function mix(o1,o2){
  for(var i in o2){
    if(o2.hasOwnProperty(i)) o1[i] = o2[i];
  }
}

function translate(o,o2){
  var out = {};
  Object.keys(o).forEach(function(k){
    out[o[k]] = o2[k];
  });
  return out;
}
