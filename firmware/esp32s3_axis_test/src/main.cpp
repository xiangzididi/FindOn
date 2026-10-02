// GEWU bench firmware for hardware without endstop switches.
// No homing, absolute coordinates, Wi-Fi, continuous motion or automatic tasks.
#include <Arduino.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

constexpr char VERSION[] = "GEWU-AXIS-TEST-2.3-E-SLOW-CALIBRATION";
constexpr int X_STEP = 17, X_DIR = 18, E_STEP = 15, E_DIR = 16, E_EN = 7;

// X: 1.8 degrees, 16 microsteps, 50:1 gearbox, 2 mm leadscrew lead.
// E uses an optical-drive motor and a T4 screw; its scale is not calibrated.
constexpr uint32_t X_PULSES_PER_MM = 80000;

// PD42S1 example wiring uses common-anode STEP: idle HIGH, active LOW.
// A4988 STEP uses the usual idle LOW, active HIGH.
constexpr uint32_t X_PERIOD_US = 50;   // 20000 pulse/s = 0.25 mm/s
constexpr uint32_t E_PERIOD_US = 10000;  // 100 pulse/s, observable raw-pulse calibration
constexpr uint32_t ACTIVE_US = 20;
constexpr uint32_t ARM_MS = 10000, MOVE_TIMEOUT_MS = 8000;

char line[80];
size_t used = 0;
bool dropping = false;
char armed = 0, moving = 0;
bool pulseActive = false;
uint32_t armedAt = 0, startedAt = 0, edgeAt = 0;
uint32_t periodUs = 0, remaining = 0, emitted = 0;
int stepPin = -1;

int stepIdleLevel(char axis) { return axis == 'X' ? HIGH : LOW; }
int stepActiveLevel(char axis) { return axis == 'X' ? LOW : HIGH; }

void stopMotion(const char *reason) {
  digitalWrite(X_STEP, HIGH);
  digitalWrite(E_STEP, LOW);
  digitalWrite(E_EN, HIGH);  // X EN is unconnected, so X holding torque can remain.
  moving = 0;
  armed = 0;
  pulseActive = false;
  remaining = 0;
  Serial.printf("STOP reason=%s emitted_pulses=%lu position=UNREFERENCED\n",
                reason, static_cast<unsigned long>(emitted));
}

void status() {
  Serial.printf(
      "%s mode=BENCH armed=%c moving=%c endstops=NONE homing=UNAVAILABLE "
      "Xmicrostep=16 Xgear=50:1 Xscale=80000pulse/mm "
      "Escale=UNCALIBRATED Erate=100pulse/s EmaxRawPulse=320 position=UNREFERENCED\n",
      VERSION, armed ? armed : '-', moving ? moving : '-');
}

void help() {
  Serial.println("STATUS | ARM X CLEAR | JOG X 0.5 | ARM E CLEAR | PULSE E 320 | STOP | !");
  Serial.println("ARM confirms current limit, clear path and distance to both hard ends.");
  Serial.println("One move per ARM; ARM expires in 10s. X: +/-0.1..1.0 mm. E: +/-16..320 raw pulses at 100 pulse/s.");
  Serial.println("+ means DIR HIGH; physical direction and displacement are UNVERIFIED.");
  Serial.println("No endstops, HOME, continuous SPIN or automatic FETCH. Position is unreferenced.");
  Serial.println("Motor power off before wiring or manual repositioning. X EN is not controlled.");
}

void command(char *input) {
  if (!strcmp(input, "STOP")) {
    stopMotion("COMMAND");
    return;
  }
  // Any complete command during motion stops it; commands are never queued.
  if (moving) {
    stopMotion("COMMAND_DURING_MOTION");
    return;
  }
  if (!strcmp(input, "STATUS")) {
    status();
    return;
  }
  if (!strcmp(input, "HELP")) {
    help();
    return;
  }

  char axis = 0, extra = 0;
  float mm = 0;
  if (!strcmp(input, "ARM X CLEAR") || !strcmp(input, "ARM E CLEAR")) {
    axis = input[4];
    armed = axis;
    armedAt = millis();
    Serial.printf("ARMED %c one_jog_only expires=10s NO_ENDSTOP_PROTECTION\n", axis);
    return;
  }

  long signedPulses = 0;
  if (sscanf(input, "PULSE %c %ld %c", &axis, &signedPulses, &extra) == 2 &&
      axis == 'E') {
    const bool permitted = armed == 'E' && uint32_t(millis() - armedAt) < ARM_MS;
    armed = 0;
    if (!permitted) {
      Serial.println("REJECT ARM_REQUIRED");
      return;
    }
    if ((signedPulses > -16 && signedPulses < 16) ||
        signedPulses < -320 || signedPulses > 320) {
      Serial.println("REJECT E_RAW_RANGE_16_TO_320_PULSES");
      return;
    }

    stepPin = E_STEP;
    periodUs = E_PERIOD_US;
    digitalWrite(E_DIR, signedPulses > 0 ? HIGH : LOW);
    digitalWrite(E_STEP, LOW);
    remaining = static_cast<uint32_t>(signedPulses > 0 ? signedPulses : -signedPulses);
    emitted = 0;
    pulseActive = false;
    digitalWrite(E_EN, LOW);
    moving = 'E';
    startedAt = millis();
    edgeAt = micros();
    Serial.printf("START E raw_pulses=%lu DIR=%s SCALE=UNCALIBRATED\n",
                  static_cast<unsigned long>(remaining),
                  signedPulses > 0 ? "HIGH" : "LOW");
    return;
  }

  if (sscanf(input, "JOG %c %f %c", &axis, &mm, &extra) == 2 &&
      (axis == 'X' || axis == 'E')) {
    if (axis == 'E') {
      armed = 0;
      Serial.println("REJECT E_SCALE_UNCALIBRATED_USE_PULSE");
      return;
    }
    const bool permitted = armed == axis && uint32_t(millis() - armedAt) < ARM_MS;
    armed = 0;
    if (!permitted) {
      Serial.println("REJECT ARM_REQUIRED");
      return;
    }
    if (!isfinite(mm) || fabsf(mm) < 0.1f || fabsf(mm) > 1.0f) {
      Serial.println("REJECT X_RANGE_0.1_TO_1.0_MM");
      return;
    }

    const uint32_t scale = X_PULSES_PER_MM;
    stepPin = X_STEP;
    periodUs = X_PERIOD_US;
    digitalWrite(X_DIR, mm > 0 ? HIGH : LOW);
    digitalWrite(stepPin, stepIdleLevel(axis));
    remaining = lroundf(fabsf(mm) * scale);
    emitted = 0;
    pulseActive = false;
    moving = axis;
    startedAt = millis();
    edgeAt = micros();
    Serial.printf("START %c pulses=%lu DIR=%s NO_ENDSTOP_PROTECTION\n", axis,
                  static_cast<unsigned long>(remaining), mm > 0 ? "HIGH" : "LOW");
    return;
  }

  armed = 0;
  Serial.println("REJECT UNKNOWN_COMMAND; send HELP");
}

void tickMotion() {
  if (!moving) return;
  if (uint32_t(millis() - startedAt) > MOVE_TIMEOUT_MS) {
    stopMotion("TIMEOUT");
    return;
  }
  const uint32_t current = micros();
  if (pulseActive) {
    if (uint32_t(current - edgeAt) >= ACTIVE_US) {
      digitalWrite(stepPin, stepIdleLevel(moving));
      pulseActive = false;
      edgeAt = current;
      if (!remaining) stopMotion("PULSE_SEQUENCE_DONE_NOT_POSITION_FEEDBACK");
    }
  } else if (uint32_t(current - edgeAt) >= periodUs - ACTIVE_US) {
    digitalWrite(stepPin, stepActiveLevel(moving));
    pulseActive = true;
    edgeAt = current;
    --remaining;
    ++emitted;
  }
}

void setup() {
  // Preload every safe/idle level before switching pins to output mode.
  digitalWrite(E_EN, HIGH);
  pinMode(E_EN, OUTPUT);
  digitalWrite(X_STEP, HIGH);
  pinMode(X_STEP, OUTPUT);
  digitalWrite(E_STEP, LOW);
  pinMode(E_STEP, OUTPUT);
  digitalWrite(X_DIR, LOW);
  pinMode(X_DIR, OUTPUT);
  digitalWrite(E_DIR, LOW);
  pinMode(E_DIR, OUTPUT);
  Serial.begin(115200);  // Never wait for USB and never move on boot.
}

void loop() {
  tickMotion();
  if (armed && uint32_t(millis() - armedAt) >= ARM_MS) {
    armed = 0;
    Serial.println("DISARMED EXPIRED");
  }

  int budget = 32;
  while (Serial.available() && budget-- > 0) {
    const char ch = Serial.read();
    if (ch == '!') {
      stopMotion("IMMEDIATE_STOP");
      used = 0;
      dropping = true;
    } else if (ch == '\n') {
      if (!dropping && used) {
        line[used] = 0;
        command(line);
      }
      used = 0;
      dropping = false;
    } else if (ch != '\r' && !dropping) {
      if (used >= sizeof(line) - 1) {
        stopMotion("INPUT_OVERFLOW");
        used = 0;
        dropping = true;
      } else {
        line[used++] = ch;
      }
    }
    tickMotion();
  }
}
