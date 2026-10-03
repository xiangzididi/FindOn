#pragma once

#include <stdint.h>

namespace partgo {

enum class EAxisStartResult : uint8_t {
  STARTED,
  ALREADY_AT_TARGET,
  BUSY,
  POSITION_UNKNOWN,
  INVALID_COMMAND,
};

enum class EAxisTickResult : uint8_t {
  IDLE,
  RUNNING,
  COMPLETED,
  TIMED_OUT,
};

struct EAxisConfig {
  int stepPin;
  int directionPin;
  int enablePin;
  bool directionHighExtends;
  uint32_t scaleNumerator;
  uint32_t scaleDivisor;
  uint32_t activePulseUs;
  uint32_t timeoutMarginMs;
  uint32_t timeoutMaximumMs;
};

// Dedicated controller for the A4988-driven extraction axis. The class owns
// every E-axis output and keeps E motion independent from X-axis timing.
class EAxisController {
 public:
  explicit EAxisController(const EAxisConfig &config);

  void begin();
  void referenceRetracted();
  void invalidatePosition();
  void stopAndDisable();

  EAxisStartResult startAbsolute(int32_t targetUm, uint32_t periodUs,
                                 bool holdAfterCompletion);
  EAxisStartResult startRawSigned(int32_t signedPulses, uint32_t periodUs);
  EAxisTickResult tick();

  uint32_t pulsesForDistanceUm(int32_t distanceUm) const;
  bool busy() const { return active_; }
  bool positionKnown() const { return positionKnown_; }
  int32_t positionUm() const { return positionUm_; }
  uint32_t emittedPulses() const { return emittedPulses_; }
  uint32_t commandedPulses() const { return totalPulses_; }
  bool directionPinHigh() const { return directionPinHigh_; }

 private:
  EAxisStartResult startLogical(bool extends, uint32_t pulses,
                                uint32_t periodUs, bool holdAfterCompletion,
                                bool absoluteMove, int32_t targetUm);
  void disableDriver();

  EAxisConfig config_;
  bool active_ = false;
  bool pulseHigh_ = false;
  bool holdAfterCompletion_ = false;
  bool absoluteMove_ = false;
  bool positionKnown_ = false;
  bool directionPinHigh_ = false;
  int32_t positionUm_ = 0;
  int32_t targetUm_ = 0;
  uint32_t remainingPulses_ = 0;
  uint32_t totalPulses_ = 0;
  uint32_t emittedPulses_ = 0;
  uint32_t periodUs_ = 0;
  uint32_t edgeAtUs_ = 0;
  uint32_t startedAtMs_ = 0;
  uint32_t timeoutMs_ = 0;
};

}  // namespace partgo
