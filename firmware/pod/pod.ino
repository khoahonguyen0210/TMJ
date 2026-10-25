#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

const int SDA_PIN = 8;
const int SCL_PIN = 9;
const int SPEAKER_PIN = 7;

const char *DEVICE_NAME = "RollWatch-Pod";
const char *SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
const char *RX_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
const char *TX_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
const int CHUNK_BYTES = 20;

const byte IMU_ADDR = 0x68;
const float LSB_PER_G = 16384.0;

const float Z_OFFSET_G = 0.48;

const int Z_SIGN = 1;

const float FLIP_Z = -0.7;
const float OK_Z = 0.7;
const float SMOOTHING = 0.2;
const unsigned long FLIP_CONFIRM_MS = 3000;
const unsigned long DEMO_CONFIRM_MS = 1000;

const unsigned long SAMPLE_MS = 20;
const unsigned long SEND_MS = 200;
const unsigned long STATUS_MS = 5000;
const unsigned long READVERTISE_MS = 500;
const int MOTION_SAMPLES = 50;
const unsigned long BASE_LOST_MS = 12000;

struct Step {
  unsigned int hz;
  unsigned int ms;
};
const Step LEVEL1[] = { {1000, 200}, {0, 800} };
const Step LEVEL2[] = { {1500, 200}, {0, 300} };
const Step LEVEL3[] = { {1000, 250}, {1500, 250} };
const Step WARNING[] = { {800, 100}, {0, 50} };
const Step TEST[] = { {1200, 100}, {0, 100}, {1200, 100}, {0, 100}, {1200, 100}, {0, 50} };

bool imuOk = false;
bool hasSample = false;
float zSmooth = 0;
float xSmooth = 0;
float rawSmooth[3] = {0, 0, 0};

bool calibrated = false;
float upAxis[3] = {0, 0, 1};
float sideAxis[3] = {1, 0, 0};
Preferences prefs;
float magnitudes[MOTION_SAMPLES];
int magCount = 0;
int magNext = 0;
bool flipped = false;
bool demoMode = false;
bool belowFlip = false;
unsigned long belowSinceMs = 0;

unsigned long lastSampleMs = 0;
unsigned long lastSendMs = 0;
unsigned long lastStatusMs = 0;

BLECharacteristic *txChar = nullptr;
volatile bool bleConnected = false;
volatile bool bleJustDisconnected = false;
unsigned long disconnectedAtMs = 0;

String serialCommand = "";
String bleCommand = "";
volatile bool bleCommandReady = false;

const Step *alarmSteps = nullptr;
int alarmCount = 0;
const Step *steps = nullptr;
int stepCount = 0;
int stepIndex = 0;
bool playingShot = false;
unsigned long stepStartMs = 0;
unsigned long lastBaseCmdMs = 0;
bool selfAlarm = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    bleConnected = true;
  }
  void onDisconnect(BLEServer *server) override {
    bleConnected = false;
    bleJustDisconnected = true;
  }
};

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    if (bleCommandReady) return;
    bleCommand = String(c->getValue().c_str());
    bleCommandReady = true;
  }
};

void bleSetup() {
  BLEDevice::init(DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(SERVICE_UUID);
  txChar = service->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic *rxChar = service->createCharacteristic(
    RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rxChar->setCallbacks(new RxCallbacks());
  service->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

void sendLine(const String &line) {
  Serial.println(line);
  if (!bleConnected || txChar == nullptr) return;
  String withNewline = line + "\n";
  const uint8_t *bytes = (const uint8_t *)withNewline.c_str();
  int len = withNewline.length();
  for (int i = 0; i < len; i += CHUNK_BYTES) {
    int n = min(CHUNK_BYTES, len - i);
    txChar->setValue((uint8_t *)(bytes + i), n);
    txChar->notify();
  }
}

bool imuInit() {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;

  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x1C);
  Wire.write(0x00);
  return Wire.endTransmission() == 0;
}

bool imuRead(float &xOut, float &zOut, float &magOut, float rawOut[3]) {
  Wire.beginTransmission(IMU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(IMU_ADDR, (uint8_t)6) != 6) return false;

  int16_t raw[3];
  for (int i = 0; i < 3; i++) {
    uint16_t high = Wire.read();
    uint16_t low = Wire.read();
    raw[i] = (int16_t)((high << 8) | low);
  }
  float x = raw[0] / LSB_PER_G;
  float y = raw[1] / LSB_PER_G;
  float zr = raw[2] / LSB_PER_G;
  rawOut[0] = x;
  rawOut[1] = y;
  rawOut[2] = zr;
  magOut = sqrt(x * x + y * y + zr * zr);
  if (calibrated) {
    zOut = x * upAxis[0] + y * upAxis[1] + zr * upAxis[2];
    xOut = x * sideAxis[0] + y * sideAxis[1] + zr * sideAxis[2];
  } else {
    xOut = x;
    zOut = Z_SIGN * (zr - Z_OFFSET_G);
  }
  return true;
}

bool calibrate() {
  float len = sqrt(rawSmooth[0] * rawSmooth[0] + rawSmooth[1] * rawSmooth[1] + rawSmooth[2] * rawSmooth[2]);
  if (!hasSample || len < 0.5) return false;
  for (int i = 0; i < 3; i++) upAxis[i] = rawSmooth[i] / len;
  int pick = 0;
  for (int i = 1; i < 3; i++) if (fabs(upAxis[i]) < fabs(upAxis[pick])) pick = i;
  float side[3] = {0, 0, 0};
  side[pick] = 1;
  float d = upAxis[pick];
  float sideLen = 0;
  for (int i = 0; i < 3; i++) {
    side[i] -= d * upAxis[i];
    sideLen += side[i] * side[i];
  }
  sideLen = sqrt(sideLen);
  for (int i = 0; i < 3; i++) sideAxis[i] = side[i] / sideLen;
  calibrated = true;
  prefs.putBool("cal", true);
  prefs.putBytes("up", upAxis, sizeof(upAxis));
  prefs.putBytes("side", sideAxis, sizeof(sideAxis));
  hasSample = false;
  return true;
}

void loadCalibration() {
  prefs.begin("rollwatch", false);
  calibrated = prefs.getBool("cal", false);
  if (calibrated) {
    prefs.getBytes("up", upAxis, sizeof(upAxis));
    prefs.getBytes("side", sideAxis, sizeof(sideAxis));
  }
}

float motion() {
  if (magCount == 0) return 0;
  float mean = 0;
  for (int i = 0; i < magCount; i++) mean += magnitudes[i];
  mean /= magCount;
  float var = 0;
  for (int i = 0; i < magCount; i++) var += (magnitudes[i] - mean) * (magnitudes[i] - mean);
  return sqrt(var / magCount);
}

void sendStatus() {
  sendLine(imuOk ? "# ROLLWATCH fw=3 imu=ok link=ble" : "# ERR imu not found");
}

void sendState(unsigned long now) {
  String line = "S,";
  line += now;
  line += flipped ? ",FLIPPED," : ",OK,";
  line += String(zSmooth, 2);
  line += ",";
  line += String(xSmooth, 2);
  line += ",";
  line += String(motion(), 2);
  sendLine(line);
}

void updateState(unsigned long now) {
  unsigned long confirmMs = demoMode ? DEMO_CONFIRM_MS : FLIP_CONFIRM_MS;

  if (!flipped) {
    if (zSmooth < FLIP_Z) {
      if (!belowFlip) {
        belowFlip = true;
        belowSinceMs = now;
      }
      if (now - belowSinceMs >= confirmMs) {
        flipped = true;
      }
    } else {
      belowFlip = false;
    }
  } else if (zSmooth > OK_Z) {
    flipped = false;
    belowFlip = false;
  }
}

void sample(unsigned long now) {
  if (!imuOk) return;

  float x, z, mag, raw[3];
  if (!imuRead(x, z, mag, raw)) {
    imuOk = false;
    hasSample = false;
    magCount = 0;
    sendStatus();
    return;
  }

  if (!hasSample) {
    zSmooth = z;
    xSmooth = x;
    for (int i = 0; i < 3; i++) rawSmooth[i] = raw[i];
    hasSample = true;
  } else {
    zSmooth = zSmooth + SMOOTHING * (z - zSmooth);
    xSmooth = xSmooth + SMOOTHING * (x - xSmooth);
    for (int i = 0; i < 3; i++) rawSmooth[i] += SMOOTHING * (raw[i] - rawSmooth[i]);
  }

  magnitudes[magNext] = mag;
  magNext = (magNext + 1) % MOTION_SAMPLES;
  if (magCount < MOTION_SAMPLES) magCount++;
  updateState(now);
}

void playStep(unsigned long now) {
  stepStartMs = now;
  if (steps == nullptr || steps[stepIndex].hz == 0) {
    noTone(SPEAKER_PIN);
  } else {
    tone(SPEAKER_PIN, steps[stepIndex].hz);
  }
}

void startAlarm(unsigned long now) {
  playingShot = false;
  steps = alarmSteps;
  stepCount = alarmCount;
  stepIndex = 0;
  playStep(now);
}

void setAlarm(const Step *pattern, int count, unsigned long now) {
  alarmSteps = pattern;
  alarmCount = count;
  if (!playingShot) startAlarm(now);
}

void playShot(const Step *pattern, int count, unsigned long now) {
  playingShot = true;
  steps = pattern;
  stepCount = count;
  stepIndex = 0;
  playStep(now);
}

void updateSound(unsigned long now) {
  if (steps == nullptr) return;
  if (now - stepStartMs < steps[stepIndex].ms) return;
  stepIndex++;
  if (stepIndex >= stepCount) {
    if (playingShot) {
      startAlarm(now);
      return;
    }
    stepIndex = 0;
  }
  playStep(now);
}

void selfAlarmCheck(unsigned long now) {
  bool baseLost = lastBaseCmdMs == 0 ? !bleConnected : (now - lastBaseCmdMs >= BASE_LOST_MS);
  bool want = flipped && baseLost;
  if (want && !selfAlarm) {
    selfAlarm = true;
    setAlarm(LEVEL1, 2, now);
  } else if (!want && selfAlarm) {
    selfAlarm = false;
    setAlarm(nullptr, 0, now);
  }
}

void handleCommand(String cmd) {
  cmd.trim();
  unsigned long now = millis();
  if (cmd == "D,1") {
    demoMode = true;
    sendLine("# demo=1");
    return;
  }
  if (cmd == "D,0") {
    demoMode = false;
    sendLine("# demo=0");
    return;
  }
  if (cmd == "C,1") {
    sendLine(calibrate() ? "# calibrated" : "# ERR calibrate: no sensor reading");
    return;
  }
  if (cmd == "C,0") {
    calibrated = false;
    prefs.putBool("cal", false);
    hasSample = false;
    sendLine("# calibration cleared");
    return;
  }

  bool known = true;
  if (cmd == "A,0") setAlarm(nullptr, 0, now);
  else if (cmd == "A,1") setAlarm(LEVEL1, 2, now);
  else if (cmd == "A,2") setAlarm(LEVEL2, 2, now);
  else if (cmd == "A,3") setAlarm(LEVEL3, 2, now);
  else if (cmd == "W,1") playShot(WARNING, 2, now);
  else if (cmd == "T,1") playShot(TEST, 6, now);
  else known = false;

  if (known) {
    lastBaseCmdMs = now;
    selfAlarm = false;
    sendLine("# OK " + cmd);
  }
}

void readSerialCommands() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      handleCommand(serialCommand);
      serialCommand = "";
    } else if (serialCommand.length() < 32) {
      serialCommand += c;
    }
  }
}

void readBleCommands() {
  if (!bleCommandReady) return;
  String cmd = bleCommand;
  bleCommandReady = false;
  handleCommand(cmd);
}

void keepAdvertising(unsigned long now) {
  if (bleJustDisconnected) {
    bleJustDisconnected = false;
    disconnectedAtMs = now;
  }
  if (disconnectedAtMs != 0 && now - disconnectedAtMs >= READVERTISE_MS) {
    disconnectedAtMs = 0;
    BLEDevice::startAdvertising();
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setTimeOut(3);
  pinMode(SPEAKER_PIN, OUTPUT);
  loadCalibration();
  imuOk = imuInit();
  bleSetup();
  sendStatus();
  lastStatusMs = millis();
}

void loop() {
  unsigned long now = millis();

  readSerialCommands();
  readBleCommands();
  keepAdvertising(now);

  if (now - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = now;
    sample(now);
  }

  if (now - lastSendMs >= SEND_MS) {
    lastSendMs = now;
    if (imuOk && hasSample) sendState(now);
  }

  if (now - lastStatusMs >= STATUS_MS) {
    lastStatusMs = now;
    if (!imuOk) imuOk = imuInit();
    sendStatus();
  }

  selfAlarmCheck(now);
  updateSound(now);
}
