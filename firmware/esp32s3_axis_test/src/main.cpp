// GEWU bench firmware for hardware without endstop switches.
// No homing, absolute coordinates, Wi-Fi, continuous motion or automatic tasks.
#include <Arduino.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

constexpr char VERSION[] = "GEWU-AXIS-TEST-3.0-X-TRAVEL-20MM";
constexpr int X_STEP = 17, X_DIR = 18, E_STEP = 15, E_DIR = 16, E_EN = 7;

// X measured 2026-10-03: 400000 pulses moved 20 mm in both directions and
// returned with 0 mm observed error. This measured scale overrides the earlier
// 80000 pulse/mm value calculated from still-unverified mechanical parameters.
// E uses an optical-drive motor and a T4 screw; its scale is not calibrated.
constexpr uint32_t X_PULSES_PER_MM = 20000;

// PD42S1 example wiring uses common-anode STEP: idle HIGH, active LOW.
// A4988 STEP uses the usual idle LOW, active HIGH.
constexpr uint32_t X_START_PERIOD_US = 50;   // 20000 pulse/s = 1 mm/s
constexpr uint32_t X_CRUISE_PERIOD_US = 17;  // ~58823 pulse/s = ~2.94 mm/s
constexpr uint32_t X_RAMP_PULSES = 2000;     // 0.10 mm at the measured scale
constexpr uint32_t E_PERIOD_US = 3333;       // ~300 pulse/s; E remains uncalibrated
constexpr uint32_t X_ACTIVE_US = 5;
constexpr uint32_t E_ACTIVE_US = 20;
constexpr uint32_t DIAG_PERIOD_US = 200000;  // 5 pulse/s
constexpr uint32_t DIAG_ACTIVE_US = 100000;  // active 100 ms, idle 100 ms
constexpr uint32_t DIAG_MAX_PULSES = 50;     // 10 seconds at 5 pulse/s
constexpr uint32_t ARM_MS = 10000, MOVE_TIMEOUT_MS = 12000;

char line[80];
size_t used = 0;
bool dropping = false;
char armed = 0, moving = 0;
bool pulseActive = false, xRampEnabled = false;
uint32_t armedAt = 0, startedAt = 0, edgeAt = 0;
uint32_t periodUs = 0, activeUs = E_ACTIVE_US, remaining = 0, emitted = 0;
int stepPin = -1;

int stepIdleLevel(char axis) { return axis == 'X' ? HIGH : LOW; }
int stepActiveLevel(char axis) { return axis == 'X' ? LOW : HIGH; }

uint32_t xPeriodForNextPulse() {
  uint32_t rampProgress = emitted < remaining ? emitted : remaining;
  if (rampProgress > X_RAMP_PULSES) rampProgress = X_RAMP_PULSES;
  const uint32_t periodDrop =
      (X_START_PERIOD_US - X_CRUISE_PERIOD_US) * rampProgress / X_RAMP_PULSES;
  return X_START_PERIOD_US - periodDrop;
}

void stopMotion(const char *reason) {
  digitalWrite(X_STEP, HIGH);
  digitalWrite(E_STEP, LOW);
  digitalWrite(E_EN, HIGH);  // X EN is unconnected, so X holding torque can remain.
  moving = 0;
  armed = 0;
  pulseActive = false;
  xRampEnabled = false;
  remaining = 0;
  Serial.printf("STOP reason=%s emitted_pulses=%lu position=UNREFERENCED\n",
                reason, static_cast<unsigned long>(emitted));
}

void status() {
  Serial.printf(
      "%s mode=BENCH armed=%c moving=%c endstops=NONE homing=UNAVAILABLE "
      "Xmicrostep=16 Xgear=50:1 Xscale=20000pulse/mm "
      "Xpeak=58823pulse/s XpeakSpeed=2.94mm/s Xramp=0.10mm "
      "Xpositive=RIGHT XlongMax=20mm "
      "XEdiag=5pulse/s Escale=UNCALIBRATED Erate=300pulse/s "
      "EmaxRawPulse=320 position=UNREFERENCED\n",
      VERSION, armed ? armed : '-', moving ? moving : '-');
}

void help() {
  Serial.println("STATUS | ARM X CLEAR | TEST X 10 | JOG X 0.5 | TRAVEL X 5 | ARM E CLEAR | TEST E 10 | PULSE E 320 | STOP | !");
  Serial.println("ARM confirms current limit, clear path and distance to both hard ends.");
  Serial.println("TEST X/E 1..50 emits visible 5 Hz pulses; X is active-LOW, E is active-HIGH.");
  Serial.println("One move per ARM; ARM expires in 10s. X JOG: +/-0.1..1.0 mm; X TRAVEL: +/-1..20 mm; E: +/-16..320 raw pulses at 300 pulse/s.");
  Serial.println("X + means RIGHT and uses measured 20000 pulse/mm; E + means DIR HIGH.");
  Serial.println("No endstops, HOME, continuous SPIN or automatic FETCH. Position is unreferenced.");
  Serial.println("Motor power off before wiring or manual repositioning. X EN is not controlled.");
}

void startXMotion(float mm, const char *commandName) {
  stepPin = X_STEP;
  periodUs = X_START_PERIOD_US;
  activeUs = X_ACTIVE_US;
  xRampEnabled = true;
  digitalWrite(X_DIR, mm > 0 ? HIGH : LOW);
  digitalWrite(X_STEP, HIGH);
  remaining = lroundf(fabsf(mm) * X_PULSES_PER_MM);
  emitted = 0;
  pulseActive = false;
  moving = 'X';
  startedAt = millis();
  edgeAt = micros();
  Serial.printf(
      "START %s X distance=%.3fmm pulses=%lu DIR=%s ramp_start=20000pulse/s "
      "peak=58823pulse/s ramp=2000pulse NO_ENDSTOP_PROTECTION\n",
      commandName, mm, static_cast<unsigned long>(remaining),
      mm > 0 ? "HIGH" : "LOW");
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
    Serial.printf("ARMED %c one_motion_only expires=10s NO_ENDSTOP_PROTECTION\n", axis);
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
    activeUs = E_ACTIVE_US;
    xRampEnabled = false;
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

  long diagnosticPulses = 0;
  if (sscanf(input, "TEST %c %ld %c", &axis, &diagnosticPulses, &extra) == 2 &&
      (axis == 'X' || axis == 'E')) {
    const bool permitted = armed == axis && uint32_t(millis() - armedAt) < ARM_MS;
    armed = 0;
    if (!permitted) {
      Serial.println("REJECT ARM_REQUIRED");
      return;
    }
    if (diagnosticPulses < 1 || diagnosticPulses > DIAG_MAX_PULSES) {
      Serial.println("REJECT DIAG_RANGE_1_TO_50_PULSES");
      return;
    }

    stepPin = axis == 'X' ? X_STEP : E_STEP;
    periodUs = DIAG_PERIOD_US;
    activeUs = DIAG_ACTIVE_US;
    xRampEnabled = false;
    if (axis == 'X') {
      digitalWrite(X_DIR, HIGH);
      digitalWrite(X_STEP, HIGH);
    } else {
      digitalWrite(E_DIR, HIGH);
      digitalWrite(E_STEP, LOW);
      digitalWrite(E_EN, LOW);
    }
    remaining = static_cast<uint32_t>(diagnosticPulses);
    emitted = 0;
    pulseActive = false;
    moving = axis;
    startedAt = millis();
    edgeAt = micros();
    Serial.printf("START %c_DIAG pulses=%lu rate=5pulse/s active=%s 100ms idle=%s 100ms\n",
                  axis, static_cast<unsigned long>(remaining),
                  axis == 'X' ? "LOW" : "HIGH", axis == 'X' ? "HIGH" : "LOW");
    return;
  }

  if (sscanf(input, "TRAVEL %c %f %c", &axis, &mm, &extra) == 2 && axis == 'X') {
    const bool permitted = armed == 'X' && uint32_t(millis() - armedAt) < ARM_MS;
    armed = 0;
    if (!permitted) {
      Serial.println("REJECT ARM_REQUIRED");
      return;
    }
    if (!isfinite(mm) || fabsf(mm) < 1.0f || fabsf(mm) > 20.0f) {
      Serial.println("REJECT X_TRAVEL_RANGE_1_TO_20_MM");
      return;
    }
    startXMotion(mm, "TRAVEL");
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

    startXMotion(mm, "JOG");
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
    if (uint32_t(current - edgeAt) >= activeUs) {
      digitalWrite(stepPin, stepIdleLevel(moving));
      pulseActive = false;
      edgeAt = current;
      if (!remaining) stopMotion("PULSE_SEQUENCE_DONE_NOT_POSITION_FEEDBACK");
    }
  } else {
    if (xRampEnabled) periodUs = xPeriodForNextPulse();
    if (uint32_t(current - edgeAt) < periodUs - activeUs) return;
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
