// ESP32-S3 SERIAL PROTOCOL DEMO ONLY. No GPIO, motors, or physical sensors.
// Arduino-ESP32 + ArduinoJson 7. Select your exact board before uploading.
#include <Arduino.h>
#include <ArduinoJson.h>

const char *HOME_PHASES[] = {"HOMING", "E_CLEAR", "X_HOMING", "HOME_CONFIRMED"};
const char *FETCH_PHASES[] = {"E_CLEAR", "MOVING_TO_SLOT", "SLOT_REACHED", "PULLING", "EXTRACTION_REACHED", "TRANSFER_READY", "MOVING_TO_PICKUP", "PICKUP_REACHED"};
const char *RETURN_PHASES[] = {"TRANSFER_READY", "MOVING_TO_SLOT", "SLOT_REACHED", "PUSHING", "INSERTION_REACHED"};
String line, taskId, command, slotId, presentedSlot;
String usedIds[16];
unsigned int usedIndex = 0;
bool busy = false, homed = false, recovery = false, droppingLine = false;
unsigned long lastStep = 0;
int phaseIndex = 0;

void sendDoc(JsonDocument &doc) {
  doc["mode"] = "protocol_simulation";
  serializeJson(doc, Serial);
  Serial.println();
}

void ack(const String &id, bool accepted, const char *error = nullptr) {
  JsonDocument doc;
  doc["type"] = "ack"; doc["task_id"] = id; doc["accepted"] = accepted;
  if (error) doc["error"] = error;
  sendDoc(doc);
}

void result(bool success, const char *error = nullptr) {
  JsonDocument doc;
  doc["type"] = "result"; doc["task_id"] = taskId; doc["success"] = success;
  if (error) doc["error"] = error;
  sendDoc(doc);
  busy = false;
}

void status() {
  JsonDocument doc;
  doc["type"] = "status"; doc["task_id"] = taskId;
  doc["state"] = recovery ? "RECOVERY_REQUIRED" : busy ? "BUSY" : homed ? "READY" : "UNHOMED";
  doc["presented_slot"] = presentedSlot;
  doc["config_version"] = 3;
  sendDoc(doc);
}

void receive(const String &input) {
  JsonDocument doc;
  if (deserializeJson(doc, input)) { ack("", false, "INVALID_JSON"); return; }
  String type = doc["type"] | "";
  String id = doc["task_id"] | "";
  if (type == "status") { status(); return; }
  if (type == "stop") {
    if (busy) result(false, "STOPPED_POSITION_UNKNOWN");
    recovery = true; homed = false; status(); return;
  }
  if (type == "reset_simulation") {
    if (busy || doc["confirmed"].as<bool>() != true) { ack(id, false, "CONFIRM_RESET_WHILE_IDLE"); return; }
    recovery = false; homed = false; presentedSlot = ""; status(); return;
  }
  if (type != "command") { ack(id, false, "UNKNOWN_TYPE"); return; }
  if (id.length() < 1 || id.length() > 100) { ack(id, false, "INVALID_TASK_ID"); return; }
  String cmd = doc["cmd"] | "";
  String slot = doc["slot_id"] | "";
  if (doc["config_version"].as<int>() != 3) { ack(id, false, "CONFIG_MISMATCH"); return; }
  if (cmd != "HOME" && cmd != "FETCH" && cmd != "RETURN") { ack(id, false, "UNKNOWN_COMMAND"); return; }
  if (busy) { ack(id, false, "BUSY_QUERY_STATUS_DO_NOT_RESEND"); return; }
  if (recovery) { ack(id, false, "RECOVERY_REQUIRED"); return; }
  for (const String &used : usedIds) {
    if (used == id) { ack(id, false, "DUPLICATE_TASK_QUERY_STATUS"); return; }
  }
  if (cmd == "HOME" && presentedSlot.length()) { ack(id, false, "BOX_NOT_STORED"); return; }
  if (cmd != "HOME") {
    if (doc["area_clear"].as<bool>() != true) { ack(id, false, "AREA_NOT_CLEAR"); return; }
    if (!homed) { ack(id, false, "HOME_REQUIRED"); return; }
    if (slot.length() != 3 || slot[0] != 'S' || slot[1] != '0' || slot[2] < '1' || slot[2] > '2') { ack(id, false, "INVALID_SLOT"); return; }
    if (cmd == "FETCH" && presentedSlot.length()) { ack(id, false, "RETURN_CURRENT_BOX_FIRST"); return; }
    if (cmd == "RETURN" && presentedSlot != slot) { ack(id, false, "WRONG_RETURN_SLOT"); return; }
  }
  usedIds[usedIndex++ % 16] = id;
  taskId = id; command = cmd; slotId = slot;
  busy = true; phaseIndex = 0; lastStep = millis();
  ack(id, true);
}

void simulateStep() {
  if (!busy || millis() - lastStep < 650) return;
  lastStep = millis();
  const char **phases = command == "HOME" ? HOME_PHASES : command == "FETCH" ? FETCH_PHASES : RETURN_PHASES;
  int count = command == "HOME" ? 4 : command == "FETCH" ? 8 : 5;
  String phase = phases[phaseIndex];
  JsonDocument event;
  event["type"] = "event"; event["task_id"] = taskId;
  event["seq"] = phaseIndex + 1; event["phase"] = phase;
  JsonObject sensors = event["sensors"].to<JsonObject>();
  if (phase == "TRANSFER_READY") { sensors["box_clear_of_rack"] = true; sensors["box_supported"] = true; }
  if (phase == "PICKUP_REACHED") { sensors["x_in_position"] = true; sensors["location"] = "PICKUP"; }
  if (phase == "E_CLEAR") sensors["e_clear"] = true;
  if (phase == "SLOT_REACHED") { sensors["x_in_position"] = true; sensors["slot_id"] = slotId; }
  if (phase == "EXTRACTION_REACHED" || phase == "INSERTION_REACHED") {
    sensors["axis_in_position"] = true;
    sensors["axis_endpoint"] = phase == "EXTRACTION_REACHED" ? "OUT" : "IN";
  }
  if (phase == "HOME_CONFIRMED") { sensors["homed"] = true; sensors["home_reference_valid"] = true; }
  sendDoc(event);
  phaseIndex++;
  if (phaseIndex == count) {
    if (command == "HOME") homed = true;
    if (command == "FETCH") presentedSlot = slotId;
    if (command == "RETURN") presentedSlot = "";
    result(true);
  }
}

void setup() {
  Serial.begin(115200);
  line.reserve(1024);
  // Intentionally no pinMode / digitalWrite: this program cannot move a motor.
}

void loop() {
  // Bounded input work keeps the simulated state machine responsive.
  int budget = 128;
  while (Serial.available() && budget-- > 0) {
    char ch = Serial.read();
    if (ch == '\n') {
      if (!droppingLine && line.length()) receive(line);
      line = ""; droppingLine = false;
    } else if (ch != '\r' && !droppingLine) {
      if (line.length() >= 1024) { line = ""; droppingLine = true; ack("", false, "LINE_TOO_LONG"); }
      else line += ch;
    }
  }
  simulateStep();
}
