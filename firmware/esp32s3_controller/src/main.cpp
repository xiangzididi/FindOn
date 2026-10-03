// PartGo production controller for ESP32-S3-N16R8.
// USB JSONL protocol; no motion on boot; no automatic homing without switches.
#include <Arduino.h>
#include <ctype.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "machine_calibration.h"

namespace {

constexpr char FIRMWARE_VERSION[] = "PARTGO-CONTROLLER-1.2.0";
constexpr char PROTOCOL_NAME[] = "partgo-serial-v1";
constexpr int PROTOCOL_VERSION = 1;
constexpr int CONFIG_VERSION = 5;

constexpr int X_STEP_PIN = 17;
constexpr int X_DIR_PIN = 18;
constexpr int E_STEP_PIN = 15;
constexpr int E_DIR_PIN = 16;
constexpr int E_ENABLE_PIN = 7;

// PD42S1 STEP is wired common-anode: active LOW. A4988 STEP is active HIGH.
constexpr uint32_t X_ACTIVE_US = 5;
constexpr uint32_t E_ACTIVE_US = 20;
constexpr uint32_t X_START_PERIOD_US = 50;
constexpr uint32_t X_CRUISE_PERIOD_US = 17;
constexpr uint32_t X_RAMP_PULSES = 2000;
constexpr uint32_t E_PERIOD_US = 3333;
constexpr uint32_t MOTION_TIMEOUT_MARGIN_MS = 5000;
constexpr uint32_t MOTION_TIMEOUT_MAX_MS = 300000;
constexpr uint32_t MANUAL_ARM_MS = 10000;
constexpr uint32_t MANUAL_E_MAX_PULSES = 320;

constexpr int32_t X_MIN_UM = 0;
constexpr int32_t X_MAX_UM = 250000;

constexpr bool HAS_Y_AXIS = false;

struct SlotConfig {
  const char *id;
  bool enabled;
  bool requiresY;
  int32_t xUm;
};

constexpr SlotConfig SLOTS[] = {
    {"S01", true, false, S01_X_UM},
    {"S02", true, false, S02_X_UM},
    {"S03", false, true, -1},
    {"S04", false, true, -1},
};

enum class MachineState { CONFIG_LOCKED, UNREFERENCED, READY, PRESENTED, BUSY, RECOVERY_REQUIRED };
enum class Action { NONE, REFERENCE, FETCH, RETURN_BOX, MANUAL };
enum class Stage : uint8_t {
  NONE,
  FETCH_MOVE_SLOT,
  FETCH_EXTEND,
  FETCH_HOOK_SHIFT,
  FETCH_RETRACT,
  FETCH_MOVE_PICKUP,
  RETURN_MOVE_HOOKED_SLOT,
  RETURN_EXTEND,
  RETURN_UNHOOK_SHIFT,
  RETURN_RETRACT,
  RETURN_MOVE_PICKUP,
};

struct Motion {
  bool active = false;
  char axis = 0;
  int stepPin = -1;
  uint32_t remaining = 0;
  uint32_t total = 0;
  uint32_t emitted = 0;
  uint32_t periodUs = 0;
  uint32_t activeUs = 0;
  uint32_t edgeAtUs = 0;
  uint32_t startedAtMs = 0;
  uint32_t timeoutMs = 0;
  bool pulseActive = false;
  int32_t targetUm = 0;
};

MachineState machineState = MachineState::CONFIG_LOCKED;
Action action = Action::NONE;
Stage stage = Stage::NONE;
Motion motion;
int32_t xPositionUm = 0;
int32_t ePositionUm = 0;
bool referenced = false;
uint32_t eventSequence = 0;
char activeTaskId[65] = "";
char activeSlotId[5] = "";
char presentedSlotId[5] = "";
char lastTaskId[65] = "";
char inputLine[768];
size_t inputUsed = 0;
bool droppingInput = false;
char manualArmedAxis = 0;
uint32_t manualArmedAtMs = 0;

const char *stateName(MachineState value) {
  switch (value) {
    case MachineState::CONFIG_LOCKED: return "CONFIG_LOCKED";
    case MachineState::UNREFERENCED: return "UNREFERENCED";
    case MachineState::READY: return "READY";
    case MachineState::PRESENTED: return "PRESENTED";
    case MachineState::BUSY: return "BUSY";
    case MachineState::RECOVERY_REQUIRED: return "RECOVERY_REQUIRED";
  }
  return "RECOVERY_REQUIRED";
}

bool motionConfigured() {
  if (!X_PULSES_PER_MM || !E_PULSES_PER_MM || E_DOCK_UM <= 0 || E_DOCK_UM > 50000 ||
      X_HOOK_SHIFT_UM <= 0 || X_HOOK_SHIFT_UM > 20000) return false;
  for (const auto &slot : SLOTS) {
    if (!slot.enabled) continue;
    if (slot.requiresY && !HAS_Y_AXIS) return false;
    if (slot.xUm < X_MIN_UM || slot.xUm > X_MAX_UM || slot.xUm + X_HOOK_SHIFT_UM > X_MAX_UM) return false;
  }
  return true;
}

const SlotConfig *findSlot(const char *id) {
  for (const auto &slot : SLOTS) if (!strcmp(slot.id, id)) return &slot;
  return nullptr;
}

bool validId(const char *value) {
  const size_t length = strlen(value);
  if (!length || length > 64) return false;
  for (size_t i = 0; i < length; ++i) {
    const char ch = value[i];
    if (!(isalnum(static_cast<unsigned char>(ch)) || ch == '_' || ch == '-')) return false;
  }
  return true;
}

const char *skipWhitespace(const char *cursor) {
  while (*cursor && isspace(static_cast<unsigned char>(*cursor))) ++cursor;
  return cursor;
}

const char *findJsonValue(const char *json, const char *key) {
  char token[48];
  snprintf(token, sizeof(token), "\"%s\"", key);
  const char *cursor = strstr(json, token);
  if (!cursor) return nullptr;
  cursor = strchr(cursor + strlen(token), ':');
  return cursor ? skipWhitespace(cursor + 1) : nullptr;
}

bool jsonString(const char *json, const char *key, char *out, size_t outSize) {
  const char *cursor = findJsonValue(json, key);
  if (!cursor || *cursor != '"' || outSize < 2) return false;
  ++cursor;
  size_t used = 0;
  while (*cursor && *cursor != '"') {
    if (*cursor == '\\' || static_cast<unsigned char>(*cursor) < 0x20 || used + 1 >= outSize) return false;
    out[used++] = *cursor++;
  }
  if (*cursor != '"') return false;
  out[used] = 0;
  return true;
}

bool jsonBool(const char *json, const char *key, bool &value) {
  const char *cursor = findJsonValue(json, key);
  if (!cursor) return false;
  if (!strncmp(cursor, "true", 4)) { value = true; return true; }
  if (!strncmp(cursor, "false", 5)) { value = false; return true; }
  return false;
}

bool jsonInt(const char *json, const char *key, long &value) {
  const char *cursor = findJsonValue(json, key);
  if (!cursor) return false;
  char *end = nullptr;
  value = strtol(cursor, &end, 10);
  return end != cursor;
}

void sendAck(const char *taskId, bool accepted, const char *error = nullptr) {
  Serial.printf("{\"v\":1,\"type\":\"ack\",\"task_id\":\"%s\",\"accepted\":%s",
                taskId, accepted ? "true" : "false");
  if (error) Serial.printf(",\"error\":\"%s\"", error);
  Serial.println("}");
}

void sendResult(bool success, const char *error = nullptr) {
  if (!activeTaskId[0]) return;
  Serial.printf("{\"v\":1,\"type\":\"result\",\"task_id\":\"%s\",\"success\":%s,\"state\":\"%s\"",
                activeTaskId, success ? "true" : "false", stateName(machineState));
  if (error) Serial.printf(",\"error\":\"%s\"", error);
  Serial.println("}");
}

void sendEvent(const char *phase, const char *sensorFields = nullptr) {
  Serial.printf("{\"v\":1,\"type\":\"event\",\"task_id\":\"%s\",\"seq\":%lu,\"phase\":\"%s\",\"sensors\":{\"evidence\":\"open_loop_pulse_count\"",
                activeTaskId, static_cast<unsigned long>(++eventSequence), phase);
  if (sensorFields && sensorFields[0]) Serial.printf(",%s", sensorFields);
  Serial.println("}}");
}

void sendStatus(const char *type, const char *requestId) {
  const bool configured = motionConfigured();
  Serial.printf("{\"v\":1,\"type\":\"%s\",\"request_id\":\"%s\",\"protocol\":\"%s\",\"node\":\"ESP32-S3\",\"firmware\":\"%s\",\"state\":\"%s\",\"motion_configured\":%s,\"referenced\":%s,\"busy\":%s,\"config_version\":%d,",
                type, requestId, PROTOCOL_NAME, FIRMWARE_VERSION, stateName(machineState),
                configured ? "true" : "false", referenced ? "true" : "false",
                action == Action::NONE ? "false" : "true", CONFIG_VERSION);
  Serial.printf("\"layout\":{\"rows\":2,\"columns\":2,\"has_y_axis\":%s},\"calibration\":{\"x_pulse_per_mm\":%lu,\"e_pulse_per_mm\":%lu,\"e_dock_um\":%ld,\"x_hook_shift_um\":%ld},\"slots\":[",
                HAS_Y_AXIS ? "true" : "false", static_cast<unsigned long>(X_PULSES_PER_MM),
                static_cast<unsigned long>(E_PULSES_PER_MM), static_cast<long>(E_DOCK_UM),
                static_cast<long>(X_HOOK_SHIFT_UM));
  for (size_t i = 0; i < sizeof(SLOTS) / sizeof(SLOTS[0]); ++i) {
    const auto &slot = SLOTS[i];
    if (i) Serial.print(',');
    const bool calibrated = slot.xUm >= X_MIN_UM && slot.xUm <= X_MAX_UM && (!slot.requiresY || HAS_Y_AXIS);
    Serial.printf("{\"id\":\"%s\",\"enabled\":%s,\"calibrated\":%s}", slot.id,
                  slot.enabled ? "true" : "false", calibrated ? "true" : "false");
  }
  Serial.println("]}");
}

void clearTask() {
  action = Action::NONE;
  stage = Stage::NONE;
  activeTaskId[0] = 0;
  activeSlotId[0] = 0;
  eventSequence = 0;
}

void setSafeOutputs() {
  digitalWrite(X_STEP_PIN, HIGH);
  digitalWrite(E_STEP_PIN, LOW);
  digitalWrite(E_ENABLE_PIN, HIGH);
}

void invalidateReferenceAfterManualMotion() {
  referenced = false;
  xPositionUm = 0;
  ePositionUm = 0;
  machineState = motionConfigured() ? MachineState::UNREFERENCED : MachineState::CONFIG_LOCKED;
}

void stopManualMotion(const char *reason) {
  const uint32_t emitted = motion.emitted;
  setSafeOutputs();
  motion.active = false;
  manualArmedAxis = 0;
  invalidateReferenceAfterManualMotion();
  clearTask();
  Serial.printf("STOP reason=%s emitted_pulses=%lu position=UNREFERENCED\n",
                reason, static_cast<unsigned long>(emitted));
}

void failTask(const char *error) {
  setSafeOutputs();
  motion.active = false;
  referenced = false;
  machineState = motionConfigured() ? MachineState::RECOVERY_REQUIRED : MachineState::CONFIG_LOCKED;
  sendResult(false, error);
  strncpy(lastTaskId, activeTaskId, sizeof(lastTaskId) - 1);
  lastTaskId[sizeof(lastTaskId) - 1] = 0;
  clearTask();
}

uint32_t pulsesFor(char axis, int32_t deltaUm) {
  const uint32_t scale = axis == 'X' ? X_PULSES_PER_MM : E_PULSES_PER_MM;
  const uint64_t magnitude = static_cast<uint64_t>(deltaUm < 0 ? -static_cast<int64_t>(deltaUm) : deltaUm);
  return static_cast<uint32_t>((magnitude * scale + 500) / 1000);
}

uint32_t xPeriodForPulse(uint32_t emitted, uint32_t total) {
  uint32_t progress = emitted;
  const uint32_t fromEnd = total > emitted ? total - emitted : 0;
  if (fromEnd < progress) progress = fromEnd;
  if (progress > X_RAMP_PULSES) progress = X_RAMP_PULSES;
  const uint32_t drop = (X_START_PERIOD_US - X_CRUISE_PERIOD_US) * progress / X_RAMP_PULSES;
  return X_START_PERIOD_US - drop;
}

bool startAxis(char axis, int32_t targetUm) {
  const int32_t current = axis == 'X' ? xPositionUm : ePositionUm;
  const int32_t delta = targetUm - current;
  const uint32_t pulses = pulsesFor(axis, delta);
  if (!pulses) {
    if (axis == 'X') xPositionUm = targetUm; else ePositionUm = targetUm;
    return false;
  }
  motion = {};
  motion.active = true;
  motion.axis = axis;
  motion.stepPin = axis == 'X' ? X_STEP_PIN : E_STEP_PIN;
  motion.remaining = pulses;
  motion.total = pulses;
  motion.targetUm = targetUm;
  motion.activeUs = axis == 'X' ? X_ACTIVE_US : E_ACTIVE_US;
  motion.periodUs = axis == 'X' ? X_START_PERIOD_US : E_PERIOD_US;
  motion.edgeAtUs = micros();
  motion.startedAtMs = millis();
  const uint32_t nominalPeriod = axis == 'X' ? X_CRUISE_PERIOD_US : E_PERIOD_US;
  const uint64_t estimatedMs = static_cast<uint64_t>(pulses) * nominalPeriod / 1000 + MOTION_TIMEOUT_MARGIN_MS;
  motion.timeoutMs = static_cast<uint32_t>(estimatedMs > MOTION_TIMEOUT_MAX_MS ? MOTION_TIMEOUT_MAX_MS : estimatedMs);
  if (axis == 'X') {
    const bool directionHigh = (delta > 0) == X_DIR_HIGH_MOVES_RIGHT;
    digitalWrite(X_DIR_PIN, directionHigh ? HIGH : LOW);
    digitalWrite(X_STEP_PIN, HIGH);
  } else {
    const bool directionHigh = (delta > 0) == E_DIR_HIGH_EXTENDS;
    digitalWrite(E_DIR_PIN, directionHigh ? HIGH : LOW);
    digitalWrite(E_STEP_PIN, LOW);
    digitalWrite(E_ENABLE_PIN, LOW);
  }
  return true;
}

void sendManualStatus() {
  Serial.printf(
      "%s mode=FINAL_MANUAL armed=%c moving=%c endstops=NONE homing=MANUAL "
      "Xscale=%lupulse/mm XdirHigh=%s XlongMax=20mm "
      "Escale=%lupulse/mm EdirHigh=%s Erate=300pulse/s EmaxRawPulse=320 "
      "state=%s position=%s NO_ENDSTOP_PROTECTION\n",
      FIRMWARE_VERSION, manualArmedAxis ? manualArmedAxis : '-',
      action == Action::MANUAL && motion.active ? motion.axis : '-',
      static_cast<unsigned long>(X_PULSES_PER_MM),
      X_DIR_HIGH_MOVES_RIGHT ? "RIGHT" : "LEFT",
      static_cast<unsigned long>(E_PULSES_PER_MM),
      E_DIR_HIGH_EXTENDS ? "EXTEND" : "RETRACT", stateName(machineState),
      referenced ? "REFERENCED" : "UNREFERENCED");
}

bool manualAvailable() {
  if (action != Action::NONE || motion.active) {
    Serial.println("REJECT BUSY");
    return false;
  }
  if (machineState == MachineState::PRESENTED || presentedSlotId[0]) {
    Serial.println("REJECT BOX_PRESENTED_MANUAL_DISABLED");
    return false;
  }
  return true;
}

bool consumeManualArm(char axis) {
  const bool permitted = manualArmedAxis == axis &&
                         uint32_t(millis() - manualArmedAtMs) < MANUAL_ARM_MS;
  manualArmedAxis = 0;
  if (!permitted) Serial.println("REJECT ARM_REQUIRED");
  return permitted;
}

void startManualX(float mm) {
  invalidateReferenceAfterManualMotion();
  action = Action::MANUAL;
  const int32_t deltaUm = static_cast<int32_t>(lroundf(mm * 1000.0f));
  if (!startAxis('X', deltaUm)) {
    stopManualMotion("ZERO_DISTANCE");
    return;
  }
  Serial.printf(
      "START TRAVEL X distance=%.3fmm pulses=%lu DIR=%s "
      "NO_ENDSTOP_PROTECTION\n",
      mm, static_cast<unsigned long>(motion.total),
      digitalRead(X_DIR_PIN) == HIGH ? "HIGH" : "LOW");
}

void startManualE(long signedPulses) {
  invalidateReferenceAfterManualMotion();
  action = Action::MANUAL;
  motion = {};
  motion.active = true;
  motion.axis = 'E';
  motion.stepPin = E_STEP_PIN;
  motion.remaining = static_cast<uint32_t>(signedPulses > 0 ? signedPulses : -signedPulses);
  motion.total = motion.remaining;
  motion.activeUs = E_ACTIVE_US;
  motion.periodUs = E_PERIOD_US;
  motion.edgeAtUs = micros();
  motion.startedAtMs = millis();
  motion.timeoutMs = static_cast<uint32_t>(
      static_cast<uint64_t>(motion.total) * E_PERIOD_US / 1000 + MOTION_TIMEOUT_MARGIN_MS);
  digitalWrite(E_DIR_PIN, signedPulses > 0 ? HIGH : LOW);
  digitalWrite(E_STEP_PIN, LOW);
  digitalWrite(E_ENABLE_PIN, LOW);
  Serial.printf("START E raw_pulses=%lu DIR=%s SCALE=%lupulse/mm NO_ENDSTOP_PROTECTION\n",
                static_cast<unsigned long>(motion.total),
                signedPulses > 0 ? "HIGH" : "LOW",
                static_cast<unsigned long>(E_PULSES_PER_MM));
}

void handleManualCommand(char *input) {
  if (!strcmp(input, "STATUS")) {
    sendManualStatus();
    return;
  }
  if (!strcmp(input, "STOP")) {
    if (action == Action::MANUAL) stopManualMotion("COMMAND");
    else if (action != Action::NONE) failTask("STOP_REQUESTED");
    else {
      setSafeOutputs();
      manualArmedAxis = 0;
      Serial.println("STOP reason=COMMAND emitted_pulses=0 position=UNREFERENCED");
    }
    return;
  }
  if (action == Action::MANUAL || motion.active) {
    stopManualMotion("COMMAND_DURING_MOTION");
    return;
  }
  if (!strcmp(input, "ARM X CLEAR") || !strcmp(input, "ARM E CLEAR")) {
    if (!manualAvailable()) return;
    manualArmedAxis = input[4];
    manualArmedAtMs = millis();
    Serial.printf("ARMED %c one_motion_only expires=10s NO_ENDSTOP_PROTECTION\n",
                  manualArmedAxis);
    return;
  }

  char axis = 0, extra = 0;
  float mm = 0;
  if (sscanf(input, "TRAVEL %c %f %c", &axis, &mm, &extra) == 2 && axis == 'X') {
    if (!consumeManualArm('X')) return;
    if (!isfinite(mm) || fabsf(mm) < 1.0f || fabsf(mm) > 20.0f) {
      Serial.println("REJECT X_TRAVEL_RANGE_1_TO_20_MM");
      return;
    }
    if (!manualAvailable()) return;
    startManualX(mm);
    return;
  }

  long signedPulses = 0;
  if (sscanf(input, "PULSE %c %ld %c", &axis, &signedPulses, &extra) == 2 && axis == 'E') {
    if (!consumeManualArm('E')) return;
    if ((signedPulses > -16 && signedPulses < 16) ||
        signedPulses < -static_cast<long>(MANUAL_E_MAX_PULSES) ||
        signedPulses > static_cast<long>(MANUAL_E_MAX_PULSES)) {
      Serial.println("REJECT E_RAW_RANGE_16_TO_320_PULSES");
      return;
    }
    if (!manualAvailable()) return;
    startManualE(signedPulses);
    return;
  }

  manualArmedAxis = 0;
  Serial.println("REJECT UNKNOWN_COMMAND");
}

void finishSuccess() {
  if (action == Action::FETCH) {
    strncpy(presentedSlotId, activeSlotId, sizeof(presentedSlotId) - 1);
    presentedSlotId[sizeof(presentedSlotId) - 1] = 0;
    machineState = MachineState::PRESENTED;
  } else {
    if (action == Action::RETURN_BOX) presentedSlotId[0] = 0;
    machineState = MachineState::READY;
  }
  sendResult(true);
  strncpy(lastTaskId, activeTaskId, sizeof(lastTaskId) - 1);
  lastTaskId[sizeof(lastTaskId) - 1] = 0;
  clearTask();
}

void advancePlan() {
  char fields[128];
  const SlotConfig *slot = findSlot(activeSlotId);
  switch (stage) {
    case Stage::FETCH_MOVE_SLOT:
      snprintf(fields, sizeof(fields), "\"slot_id\":\"%s\",\"x_in_position\":true,\"x_um\":%ld", activeSlotId, static_cast<long>(xPositionUm));
      sendEvent("SLOT_REACHED", fields);
      sendEvent("DOCKING", "\"axis\":\"E\"");
      stage = Stage::FETCH_EXTEND;
      if (!startAxis('E', E_DOCK_UM)) advancePlan();
      break;
    case Stage::FETCH_EXTEND:
      snprintf(fields, sizeof(fields), "\"axis_in_position\":true,\"e_um\":%ld", static_cast<long>(ePositionUm));
      sendEvent("DOCK_REACHED", fields);
      snprintf(fields, sizeof(fields), "\"axis\":\"X\",\"direction\":\"RIGHT\",\"shift_um\":%ld", static_cast<long>(X_HOOK_SHIFT_UM));
      sendEvent("HOOK_SHIFTING", fields);
      stage = Stage::FETCH_HOOK_SHIFT;
      if (!startAxis('X', slot->xUm + X_HOOK_SHIFT_UM)) advancePlan();
      break;
    case Stage::FETCH_HOOK_SHIFT:
      snprintf(fields, sizeof(fields), "\"x_in_position\":true,\"hook_engaged\":true,\"x_um\":%ld", static_cast<long>(xPositionUm));
      sendEvent("HOOK_ENGAGED", fields);
      sendEvent("PULLING", "\"axis\":\"E\"");
      stage = Stage::FETCH_RETRACT;
      if (!startAxis('E', 0)) advancePlan();
      break;
    case Stage::FETCH_RETRACT:
      sendEvent("EXTRACTION_REACHED", "\"axis_in_position\":true,\"axis_endpoint\":\"RETRACTED\",\"e_um\":0");
      sendEvent("TRANSFER_READY", "\"motion_complete\":true,\"e_clear\":true");
      sendEvent("MOVING_TO_PICKUP", "\"axis\":\"X\"");
      stage = Stage::FETCH_MOVE_PICKUP;
      if (!startAxis('X', 0)) advancePlan();
      break;
    case Stage::FETCH_MOVE_PICKUP:
      sendEvent("PICKUP_REACHED", "\"x_in_position\":true,\"location\":\"PICKUP\",\"x_um\":0");
      finishSuccess();
      break;
    case Stage::RETURN_MOVE_HOOKED_SLOT:
      snprintf(fields, sizeof(fields), "\"slot_id\":\"%s\",\"x_in_position\":true,\"x_um\":%ld", activeSlotId, static_cast<long>(xPositionUm));
      sendEvent("SLOT_REACHED", fields);
      sendEvent("PUSHING", "\"axis\":\"E\"");
      stage = Stage::RETURN_EXTEND;
      if (!startAxis('E', E_DOCK_UM)) advancePlan();
      break;
    case Stage::RETURN_EXTEND:
      sendEvent("INSERTION_REACHED", "\"axis_in_position\":true,\"axis_endpoint\":\"EXTENDED\"");
      snprintf(fields, sizeof(fields), "\"axis\":\"X\",\"direction\":\"LEFT\",\"shift_um\":%ld", static_cast<long>(X_HOOK_SHIFT_UM));
      sendEvent("UNHOOKING", fields);
      stage = Stage::RETURN_UNHOOK_SHIFT;
      if (!startAxis('X', slot->xUm)) advancePlan();
      break;
    case Stage::RETURN_UNHOOK_SHIFT:
      snprintf(fields, sizeof(fields), "\"x_in_position\":true,\"hook_released\":true,\"x_um\":%ld", static_cast<long>(xPositionUm));
      sendEvent("HOOK_RELEASED", fields);
      sendEvent("RETRACTING", "\"axis\":\"E\"");
      stage = Stage::RETURN_RETRACT;
      if (!startAxis('E', 0)) advancePlan();
      break;
    case Stage::RETURN_RETRACT:
      sendEvent("E_CLEAR", "\"e_clear\":true,\"e_um\":0");
      sendEvent("MOVING_TO_PICKUP", "\"axis\":\"X\"");
      stage = Stage::RETURN_MOVE_PICKUP;
      if (!startAxis('X', 0)) advancePlan();
      break;
    case Stage::RETURN_MOVE_PICKUP:
      sendEvent("PICKUP_REACHED", "\"x_in_position\":true,\"location\":\"PICKUP\",\"x_um\":0");
      finishSuccess();
      break;
    default:
      (void)slot;
      failTask("INVALID_PLAN_STATE");
      break;
  }
}

void startReference(const char *taskId) {
  strncpy(activeTaskId, taskId, sizeof(activeTaskId) - 1);
  activeTaskId[sizeof(activeTaskId) - 1] = 0;
  action = Action::REFERENCE;
  eventSequence = 0;
  machineState = MachineState::BUSY;
  sendAck(taskId, true);
  sendEvent("REFERENCE_ACCEPTED", "\"manual_reference_confirmed\":true");
  xPositionUm = 0;
  ePositionUm = 0;
  referenced = true;
  machineState = MachineState::READY;
  sendEvent("HOME_CONFIRMED", "\"homed\":true,\"home_reference_valid\":true,\"x_um\":0,\"e_um\":0");
  finishSuccess();
}

void startBusinessTask(const char *taskId, Action nextAction, const SlotConfig &slot) {
  strncpy(activeTaskId, taskId, sizeof(activeTaskId) - 1);
  activeTaskId[sizeof(activeTaskId) - 1] = 0;
  strncpy(activeSlotId, slot.id, sizeof(activeSlotId) - 1);
  activeSlotId[sizeof(activeSlotId) - 1] = 0;
  action = nextAction;
  eventSequence = 0;
  machineState = MachineState::BUSY;
  sendAck(taskId, true);
  if (nextAction == Action::FETCH) {
    sendEvent("E_CLEAR", "\"e_clear\":true,\"e_um\":0");
    sendEvent("MOVING_TO_SLOT", "\"axis\":\"X\"");
    stage = Stage::FETCH_MOVE_SLOT;
  } else {
    sendEvent("TRANSFER_READY", "\"motion_complete\":true,\"e_clear\":true");
    sendEvent("MOVING_TO_SLOT", "\"axis\":\"X\"");
    stage = Stage::RETURN_MOVE_HOOKED_SLOT;
  }
  const int32_t targetX = nextAction == Action::FETCH ? slot.xUm : slot.xUm + X_HOOK_SHIFT_UM;
  if (!startAxis('X', targetX)) advancePlan();
}

void handleCommand(const char *json) {
  long version = 0;
  char type[20] = "";
  char requestId[65] = "";
  if (!jsonInt(json, "v", version) || version != PROTOCOL_VERSION) {
    sendAck("invalid", false, "PROTOCOL_VERSION");
    return;
  }
  if (!jsonString(json, "type", type, sizeof(type))) {
    sendAck("invalid", false, "INVALID_MESSAGE");
    return;
  }
  jsonString(json, "request_id", requestId, sizeof(requestId));
  if (!strcmp(type, "hello") || !strcmp(type, "status")) {
    if (requestId[0] && !validId(requestId)) strcpy(requestId, "invalid");
    sendStatus(type, requestId);
    return;
  }
  if (!strcmp(type, "stop")) {
    manualArmedAxis = 0;
    if (action == Action::MANUAL) stopManualMotion("STOP_REQUESTED");
    else if (action != Action::NONE) failTask("STOP_REQUESTED");
    else setSafeOutputs();
    return;
  }
  if (strcmp(type, "command")) {
    sendAck("invalid", false, "INVALID_MESSAGE");
    return;
  }
  manualArmedAxis = 0;

  char taskId[65] = "";
  char command[20] = "";
  if (!jsonString(json, "task_id", taskId, sizeof(taskId)) || !validId(taskId) ||
      !jsonString(json, "cmd", command, sizeof(command))) {
    sendAck(taskId[0] ? taskId : "invalid", false, "INVALID_MESSAGE");
    return;
  }
  if ((action != Action::NONE && !strcmp(activeTaskId, taskId)) || !strcmp(lastTaskId, taskId)) {
    sendAck(taskId, false, "DUPLICATE_TASK_ID");
    return;
  }
  if (action != Action::NONE) { sendAck(taskId, false, "BUSY"); return; }
  long configVersion = 0;
  if (!jsonInt(json, "config_version", configVersion) || configVersion != CONFIG_VERSION) {
    sendAck(taskId, false, "CONFIG_VERSION");
    return;
  }
  if (!motionConfigured()) {
    machineState = MachineState::CONFIG_LOCKED;
    sendAck(taskId, false, "CONFIG_LOCKED");
    return;
  }
  if (!strcmp(command, "REFERENCE")) {
    bool manual = false, clear = false;
    if (!jsonBool(json, "manual_reference_confirmed", manual) || !manual ||
        !jsonBool(json, "area_clear", clear) || !clear) {
      sendAck(taskId, false, "MANUAL_REFERENCE_REQUIRED");
      return;
    }
    if (presentedSlotId[0]) { sendAck(taskId, false, "BOX_ALREADY_PRESENTED"); return; }
    startReference(taskId);
    return;
  }
  if (!referenced || machineState == MachineState::UNREFERENCED || machineState == MachineState::RECOVERY_REQUIRED) {
    sendAck(taskId, false, "REFERENCE_REQUIRED");
    return;
  }
  bool areaClear = false;
  if (!jsonBool(json, "area_clear", areaClear) || !areaClear) {
    sendAck(taskId, false, "AREA_NOT_CLEAR");
    return;
  }
  char slotId[5] = "";
  if (!jsonString(json, "slot_id", slotId, sizeof(slotId))) {
    sendAck(taskId, false, "UNKNOWN_SLOT");
    return;
  }
  const SlotConfig *slot = findSlot(slotId);
  if (!slot) { sendAck(taskId, false, "UNKNOWN_SLOT"); return; }
  if (slot->requiresY && !HAS_Y_AXIS) { sendAck(taskId, false, "Y_AXIS_REQUIRED"); return; }
  if (!slot->enabled) { sendAck(taskId, false, "SLOT_DISABLED"); return; }
  if (!strcmp(command, "FETCH")) {
    if (machineState != MachineState::READY || presentedSlotId[0]) {
      sendAck(taskId, false, "BOX_ALREADY_PRESENTED");
      return;
    }
    startBusinessTask(taskId, Action::FETCH, *slot);
    return;
  }
  if (!strcmp(command, "RETURN")) {
    if (machineState != MachineState::PRESENTED || strcmp(presentedSlotId, slotId)) {
      sendAck(taskId, false, "PRESENTED_SLOT_MISMATCH");
      return;
    }
    startBusinessTask(taskId, Action::RETURN_BOX, *slot);
    return;
  }
  sendAck(taskId, false, "UNSUPPORTED_COMMAND");
}

void tickMotion() {
  if (!motion.active) return;
  if (uint32_t(millis() - motion.startedAtMs) > motion.timeoutMs) {
    if (action == Action::MANUAL) stopManualMotion("TIMEOUT");
    else failTask("MOTION_TIMEOUT");
    return;
  }
  const uint32_t current = micros();
  if (motion.pulseActive) {
    if (uint32_t(current - motion.edgeAtUs) < motion.activeUs) return;
    digitalWrite(motion.stepPin, motion.axis == 'X' ? HIGH : LOW);
    motion.pulseActive = false;
    motion.edgeAtUs = current;
    if (!motion.remaining) {
      motion.active = false;
      if (motion.axis == 'X') xPositionUm = motion.targetUm;
      else {
        ePositionUm = motion.targetUm;
        digitalWrite(E_ENABLE_PIN, HIGH);
      }
      if (action == Action::MANUAL) stopManualMotion("PULSE_SEQUENCE_DONE_NOT_POSITION_FEEDBACK");
      else advancePlan();
    }
    return;
  }
  if (motion.axis == 'X') motion.periodUs = xPeriodForPulse(motion.emitted, motion.total);
  if (uint32_t(current - motion.edgeAtUs) < motion.periodUs - motion.activeUs) return;
  digitalWrite(motion.stepPin, motion.axis == 'X' ? LOW : HIGH);
  motion.pulseActive = true;
  motion.edgeAtUs = current;
  --motion.remaining;
  ++motion.emitted;
}

}  // namespace

void setup() {
  digitalWrite(E_ENABLE_PIN, HIGH);
  pinMode(E_ENABLE_PIN, OUTPUT);
  digitalWrite(X_STEP_PIN, HIGH);
  pinMode(X_STEP_PIN, OUTPUT);
  digitalWrite(E_STEP_PIN, LOW);
  pinMode(E_STEP_PIN, OUTPUT);
  digitalWrite(X_DIR_PIN, LOW);
  pinMode(X_DIR_PIN, OUTPUT);
  digitalWrite(E_DIR_PIN, LOW);
  pinMode(E_DIR_PIN, OUTPUT);
  Serial.begin(115200);
  machineState = motionConfigured() ? MachineState::UNREFERENCED : MachineState::CONFIG_LOCKED;
}

void loop() {
  tickMotion();
  if (manualArmedAxis && uint32_t(millis() - manualArmedAtMs) >= MANUAL_ARM_MS) {
    manualArmedAxis = 0;
    Serial.println("DISARMED EXPIRED");
  }
  int budget = 48;
  while (Serial.available() && budget-- > 0) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '!') {
      if (action == Action::MANUAL) stopManualMotion("IMMEDIATE_STOP");
      else if (action != Action::NONE) failTask("IMMEDIATE_STOP");
      else setSafeOutputs();
      manualArmedAxis = 0;
      inputUsed = 0;
      droppingInput = true;
    } else if (ch == '\n') {
      if (!droppingInput && inputUsed) {
        inputLine[inputUsed] = 0;
        const char *first = skipWhitespace(inputLine);
        if (*first == '{') handleCommand(first);
        else handleManualCommand(inputLine);
      }
      inputUsed = 0;
      droppingInput = false;
    } else if (ch != '\r' && !droppingInput) {
      if (inputUsed >= sizeof(inputLine) - 1) {
        if (action != Action::NONE) failTask("INPUT_OVERFLOW");
        inputUsed = 0;
        droppingInput = true;
      } else {
        inputLine[inputUsed++] = ch;
      }
    }
    tickMotion();
  }
}
