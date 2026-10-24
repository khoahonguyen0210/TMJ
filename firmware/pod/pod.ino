#include <Wire.h>

const int SDA_PIN = 8;
const int SCL_PIN = 9;
const int SPEAKER_PIN = 7;

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
const int MOTION_SAMPLES = 50;

const int BEEP_HZ = 2000;
const unsigned long BEEP_ON_MS = 300;
const unsigned long BEEP_OFF_MS = 300;

bool imuOk = false;
bool hasSample = false;
float zSmooth = 0;
float xSmooth = 0;
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

bool beepOn = false;
unsigned long beepChangedMs = 0;

String command = "";

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

bool imuRead(float &xOut, float &zOut, float &magOut) {
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
  float z = raw[2] / LSB_PER_G - Z_OFFSET_G;
  xOut = x;
  zOut = Z_SIGN * z;
  magOut = sqrt(x * x + y * y + z * z);
  return true;
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

void printStatus() {
  if (imuOk) {
    Serial.println("# ROLLWATCH fw=2 imu=ok");
  } else {
    Serial.println("# ERR imu not found");
  }
}

void sendState(unsigned long now) {
  Serial.print("S,");
  Serial.print(now);
  Serial.print(flipped ? ",FLIPPED," : ",OK,");
  Serial.print(zSmooth, 2);
  Serial.print(",");
  Serial.print(xSmooth, 2);
  Serial.print(",");
  Serial.println(motion(), 2);
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

  float x, z, mag;
  if (!imuRead(x, z, mag)) {
    imuOk = false;
    hasSample = false;
    magCount = 0;
    printStatus();
    return;
  }

  if (!hasSample) {
    zSmooth = z;
    xSmooth = x;
    hasSample = true;
  } else {
    zSmooth = zSmooth + SMOOTHING * (z - zSmooth);
    xSmooth = xSmooth + SMOOTHING * (x - xSmooth);
  }

  magnitudes[magNext] = mag;
  magNext = (magNext + 1) % MOTION_SAMPLES;
  if (magCount < MOTION_SAMPLES) magCount++;
  updateState(now);
}

void handleCommand(String cmd) {
  cmd.trim();
  if (cmd == "D,1") {
    demoMode = true;
    Serial.println("# demo=1");
  } else if (cmd == "D,0") {
    demoMode = false;
    Serial.println("# demo=0");
  }
}

void readCommands() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      handleCommand(command);
      command = "";
    } else if (command.length() < 32) {
      command += c;
    }
  }
}

void updateBeep(unsigned long now) {
  bool shouldBeep = flipped && imuOk;

  if (!shouldBeep) {
    if (beepOn) {
      noTone(SPEAKER_PIN);
      beepOn = false;
    }
    beepChangedMs = now;
    return;
  }

  unsigned long wait = beepOn ? BEEP_ON_MS : BEEP_OFF_MS;
  if (now - beepChangedMs >= wait) {
    beepOn = !beepOn;
    if (beepOn) {
      tone(SPEAKER_PIN, BEEP_HZ);
    } else {
      noTone(SPEAKER_PIN);
    }
    beepChangedMs = now;
  }
}

void setup() {
  Serial.begin(115200);
#if defined(ARDUINO_ARCH_ESP32)
  Wire.begin(SDA_PIN, SCL_PIN);
#else
  Wire.begin();
#endif
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);
#endif
  imuOk = imuInit();
  printStatus();
  lastStatusMs = millis();
}

void loop() {
  unsigned long now = millis();

  readCommands();

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
    printStatus();
  }

  updateBeep(now);
}
