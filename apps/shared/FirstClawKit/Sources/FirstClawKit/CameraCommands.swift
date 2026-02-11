import Foundation

public enum FirstClawCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum FirstClawCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum FirstClawCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum FirstClawCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct FirstClawCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: FirstClawCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: FirstClawCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: FirstClawCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: FirstClawCameraImageFormat? = nil,
        deviceId: String? = nil,
        delayMs: Int? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
        self.deviceId = deviceId
        self.delayMs = delayMs
    }
}

public struct FirstClawCameraClipParams: Codable, Sendable, Equatable {
    public var facing: FirstClawCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: FirstClawCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: FirstClawCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: FirstClawCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
