#include "e_axis.h"

#include <Arduino.h>

namespace partgo {

EAxisController::EAxisController(const EAxisConfig &config) : config_(config) {}

void EAxisController::begin() {
  // Write safe levels before changing pin direction to prevent an enable or
  // STEP glitch during boot.
  digitalWrite(config_.enablePin, HIGH);
  pinMode(config_.enablePin, OUTPUT);
  digitalWrite(config_.stepPin, LOW);
  pinMode(config_.stepPin, OUTPUT);
  digitalWrite(config_.directionPin, LOW);
  pinMode(config_.directionPin, OUTPUT);
  active_ = false;
  pulseHigh_ = false;
  positionKnown_ = false;
}

void EAxisController::referenceRetracted() {
  if (active_) return;
  positionUm_ = 0;
  targetUm_ = 0;
  positionKnown_ = true;
}

void EAxisController::invalidatePosition() {
  positionKnown_ = false;
}

void EAxisController::disableDriver() {
  digitalWrite(config_.stepPin, LOW);
  digitalWrite(config_.enablePin, HIGH);
}

void EAxisController::stopAndDisable() {
  disableDriver();
  active_ = false;
  pulseHigh_ = false;
  positionKnown_ = false;
}

uint32_t EAxisController::pulsesForDistanceUm(int32_t distanceUm) const {
  const uint64_t magnitude = static_cast<uint64_t>(
      distanceUm < 0 ? -static_cast<int64_t>(distanceUm) : distanceUm);
  const uint64_t denominator = 1000ULL * config_.scaleDivisor;
  if (!denominator) return 0;
  return static_cast<uint32_t>(
      (magnitude * config_.scaleNumerator + denominator / 2) / denominator);
}

EAxisStartResult EAxisController::startLogical(
    bool extends, uint32_t pulses, uint32_t periodUs,
    bool holdAfterCompletion, bool absoluteMove, int32_t targetUm) {
  if (active_) return EAxisStartResult::BUSY;
  if (!pulses || periodUs <= config_.activePulseUs) {
    return EAxisStartResult::INVALID_COMMAND;
  }

  directionPinHigh_ = extends == config_.directionHighExtends;
  digitalWrite(config_.directionPin, directionPinHigh_ ? HIGH : LOW);
  digitalWrite(config_.stepPin, LOW);
  digitalWrite(config_.enablePin, LOW);

  active_ = true;
  pulseHigh_ = false;
  holdAfterCompletion_ = holdAfterCompletion;
  absoluteMove_ = absoluteMove;
  targetUm_ = targetUm;
  remainingPulses_ = pulses;
  totalPulses_ = pulses;
  emittedPulses_ = 0;
  periodUs_ = periodUs;
  edgeAtUs_ = micros();
  startedAtMs_ = millis();
  const uint64_t estimatedMs =
      static_cast<uint64_t>(pulses) * periodUs / 1000 + config_.timeoutMarginMs;
  timeoutMs_ = static_cast<uint32_t>(
      estimatedMs > config_.timeoutMaximumMs ? config_.timeoutMaximumMs
                                             : estimatedMs);
  return EAxisStartResult::STARTED;
}

EAxisStartResult EAxisController::startAbsolute(
    int32_t targetUm, uint32_t periodUs, bool holdAfterCompletion) {
  if (active_) return EAxisStartResult::BUSY;
  if (!positionKnown_) return EAxisStartResult::POSITION_UNKNOWN;
  const int32_t deltaUm = targetUm - positionUm_;
  if (!deltaUm) return EAxisStartResult::ALREADY_AT_TARGET;
  const uint32_t pulses = pulsesForDistanceUm(deltaUm);
  return startLogical(deltaUm > 0, pulses, periodUs, holdAfterCompletion,
                      true, targetUm);
}

EAxisStartResult EAxisController::startRawSigned(int32_t signedPulses,
                                                  uint32_t periodUs) {
  if (active_) return EAxisStartResult::BUSY;
  if (!signedPulses) return EAxisStartResult::INVALID_COMMAND;
  const uint32_t pulses = static_cast<uint32_t>(
      signedPulses < 0 ? -static_cast<int64_t>(signedPulses) : signedPulses);
  const auto result =
      startLogical(signedPulses > 0, pulses, periodUs, false, false, 0);
  if (result == EAxisStartResult::STARTED) positionKnown_ = false;
  return result;
}

EAxisTickResult EAxisController::tick() {
  if (!active_) return EAxisTickResult::IDLE;
  if (static_cast<uint32_t>(millis() - startedAtMs_) > timeoutMs_) {
    stopAndDisable();
    return EAxisTickResult::TIMED_OUT;
  }

  const uint32_t nowUs = micros();
  if (pulseHigh_) {
    if (static_cast<uint32_t>(nowUs - edgeAtUs_) < config_.activePulseUs) {
      return EAxisTickResult::RUNNING;
    }
    digitalWrite(config_.stepPin, LOW);
    pulseHigh_ = false;
    edgeAtUs_ = nowUs;
    if (!remainingPulses_) {
      active_ = false;
      if (absoluteMove_) {
        positionUm_ = targetUm_;
        positionKnown_ = true;
      }
      if (!holdAfterCompletion_) disableDriver();
      return EAxisTickResult::COMPLETED;
    }
    return EAxisTickResult::RUNNING;
  }

  if (static_cast<uint32_t>(nowUs - edgeAtUs_) <
      periodUs_ - config_.activePulseUs) {
    return EAxisTickResult::RUNNING;
  }
  digitalWrite(config_.stepPin, HIGH);
  pulseHigh_ = true;
  edgeAtUs_ = nowUs;
  --remainingPulses_;
  ++emittedPulses_;
  return EAxisTickResult::RUNNING;
}

}  // namespace partgo
