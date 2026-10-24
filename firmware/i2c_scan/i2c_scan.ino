#include <Wire.h>

const int SDA_PIN = 8;
const int SCL_PIN = 9;

unsigned long lastScanMs = 0;

void scan() {
  int found = 0;
  Serial.println("# scanning I2C...");
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("# found device at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      found++;
    }
  }
  if (found == 0) {
    Serial.println("# nothing found - check 3V3/GND, swap SDA/SCL");
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
}

void loop() {
  if (millis() - lastScanMs >= 2000) {
    lastScanMs = millis();
    scan();
  }
}
