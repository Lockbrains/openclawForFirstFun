import Foundation

public enum FirstClawDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum FirstClawBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum FirstClawThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum FirstClawNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum FirstClawNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct FirstClawBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: FirstClawBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: FirstClawBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct FirstClawThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: FirstClawThermalState

    public init(state: FirstClawThermalState) {
        self.state = state
    }
}

public struct FirstClawStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct FirstClawNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: FirstClawNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [FirstClawNetworkInterfaceType]

    public init(
        status: FirstClawNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [FirstClawNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct FirstClawDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: FirstClawBatteryStatusPayload
    public var thermal: FirstClawThermalStatusPayload
    public var storage: FirstClawStorageStatusPayload
    public var network: FirstClawNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: FirstClawBatteryStatusPayload,
        thermal: FirstClawThermalStatusPayload,
        storage: FirstClawStorageStatusPayload,
        network: FirstClawNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct FirstClawDeviceInfoPayload: Codable, Sendable, Equatable {
    public var deviceName: String
    public var modelIdentifier: String
    public var systemName: String
    public var systemVersion: String
    public var appVersion: String
    public var appBuild: String
    public var locale: String

    public init(
        deviceName: String,
        modelIdentifier: String,
        systemName: String,
        systemVersion: String,
        appVersion: String,
        appBuild: String,
        locale: String)
    {
        self.deviceName = deviceName
        self.modelIdentifier = modelIdentifier
        self.systemName = systemName
        self.systemVersion = systemVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }
}
