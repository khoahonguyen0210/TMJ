const int SPEAKER_PIN = 9;
const unsigned long STATUS_MS = 5000;

struct Step {
  unsigned int hz;
  unsigned int ms;
};

const Step LEVEL1[] = { {1000, 200}, {0, 800} };
const Step LEVEL2[] = { {1500, 200}, {0, 300} };
const Step LEVEL3[] = { {1000, 250}, {1500, 250} };
const Step WARNING[] = { {800, 100}, {0, 50} };
const Step TEST[] = { {1200, 100}, {0, 100}, {1200, 100}, {0, 100}, {1200, 100}, {0, 50} };

const Step *alarmSteps = nullptr;
int alarmCount = 0;
const Step *shotSteps = nullptr;
int shotCount = 0;

const Step *steps = nullptr;
int stepCount = 0;
int stepIndex = 0;
bool playingShot = false;
unsigned long stepStartMs = 0;

unsigned long lastStatusMs = 0;
String command = "";

void playStep(unsigned long now) {
  stepStartMs = now;
  if (steps == nullptr) {
    noTone(SPEAKER_PIN);
    return;
  }
  unsigned int hz = steps[stepIndex].hz;
  if (hz == 0) {
    noTone(SPEAKER_PIN);
  } else {
    tone(SPEAKER_PIN, hz);
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

void handleCommand(String cmd, unsigned long now) {
  cmd.trim();
  bool known = true;
  if (cmd == "A,0") setAlarm(nullptr, 0, now);
  else if (cmd == "A,1") setAlarm(LEVEL1, 2, now);
  else if (cmd == "A,2") setAlarm(LEVEL2, 2, now);
  else if (cmd == "A,3") setAlarm(LEVEL3, 2, now);
  else if (cmd == "W,1") playShot(WARNING, 2, now);
  else if (cmd == "T,1") playShot(TEST, 6, now);
  else known = false;

  if (known) {
    Serial.print("# OK ");
    Serial.println(cmd);
  }
}

void readCommands(unsigned long now) {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      handleCommand(command, now);
      command = "";
    } else if (command.length() < 16) {
      command += c;
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(SPEAKER_PIN, OUTPUT);
  Serial.println("# SPEAKER fw=1");
  lastStatusMs = millis();
}

void loop() {
  unsigned long now = millis();
  readCommands(now);
  updateSound(now);

  if (now - lastStatusMs >= STATUS_MS) {
    lastStatusMs = now;
    Serial.println("# SPEAKER fw=1");
  }
}
