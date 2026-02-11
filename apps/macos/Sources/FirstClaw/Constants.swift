import Foundation

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// nix-firstclaw writes app defaults into this suite to survive app bundle identifier churn.
let launchdLabel = "ai.firstclaw.mac"
let gatewayLaunchdLabel = "ai.firstclaw.gateway"
let onboardingVersionKey = "firstclaw.onboardingVersion"
let onboardingSeenKey = "firstclaw.onboardingSeen"
let currentOnboardingVersion = 7
let pauseDefaultsKey = "firstclaw.pauseEnabled"
let iconAnimationsEnabledKey = "firstclaw.iconAnimationsEnabled"
let swabbleEnabledKey = "firstclaw.swabbleEnabled"
let swabbleTriggersKey = "firstclaw.swabbleTriggers"
let voiceWakeTriggerChimeKey = "firstclaw.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "firstclaw.voiceWakeSendChime"
let showDockIconKey = "firstclaw.showDockIcon"
let defaultVoiceWakeTriggers = ["firstclaw"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
let voiceWakeMicKey = "firstclaw.voiceWakeMicID"
let voiceWakeMicNameKey = "firstclaw.voiceWakeMicName"
let voiceWakeLocaleKey = "firstclaw.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "firstclaw.voiceWakeAdditionalLocaleIDs"
let voicePushToTalkEnabledKey = "firstclaw.voicePushToTalkEnabled"
let talkEnabledKey = "firstclaw.talkEnabled"
let iconOverrideKey = "firstclaw.iconOverride"
let connectionModeKey = "firstclaw.connectionMode"
let remoteTargetKey = "firstclaw.remoteTarget"
let remoteIdentityKey = "firstclaw.remoteIdentity"
let remoteProjectRootKey = "firstclaw.remoteProjectRoot"
let remoteCliPathKey = "firstclaw.remoteCliPath"
let canvasEnabledKey = "firstclaw.canvasEnabled"
let cameraEnabledKey = "firstclaw.cameraEnabled"
let systemRunPolicyKey = "firstclaw.systemRunPolicy"
let systemRunAllowlistKey = "firstclaw.systemRunAllowlist"
let systemRunEnabledKey = "firstclaw.systemRunEnabled"
let locationModeKey = "firstclaw.locationMode"
let locationPreciseKey = "firstclaw.locationPreciseEnabled"
let peekabooBridgeEnabledKey = "firstclaw.peekabooBridgeEnabled"
let deepLinkKeyKey = "firstclaw.deepLinkKey"
let modelCatalogPathKey = "firstclaw.modelCatalogPath"
let modelCatalogReloadKey = "firstclaw.modelCatalogReload"
let cliInstallPromptedVersionKey = "firstclaw.cliInstallPromptedVersion"
let heartbeatsEnabledKey = "firstclaw.heartbeatsEnabled"
let debugPaneEnabledKey = "firstclaw.debugPaneEnabled"
let debugFileLogEnabledKey = "firstclaw.debug.fileLogEnabled"
let appLogLevelKey = "firstclaw.debug.appLogLevel"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
