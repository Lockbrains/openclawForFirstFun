import CoreLocation
import Foundation
import FirstClawKit
import UIKit

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: FirstClawCameraSnapParams) async throws -> (format: String, base64: String, width: Int, height: Int)
    func clip(params: FirstClawCameraClipParams) async throws -> (format: String, base64: String, durationMs: Int, hasAudio: Bool)
}

protocol ScreenRecordingServicing: Sendable {
    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
}

@MainActor
protocol LocationServicing: Sendable {
    func authorizationStatus() -> CLAuthorizationStatus
    func accuracyAuthorization() -> CLAccuracyAuthorization
    func ensureAuthorization(mode: FirstClawLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: FirstClawLocationGetParams,
        desiredAccuracy: FirstClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
}

protocol DeviceStatusServicing: Sendable {
    func status() async throws -> FirstClawDeviceStatusPayload
    func info() -> FirstClawDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: FirstClawPhotosLatestParams) async throws -> FirstClawPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: FirstClawContactsSearchParams) async throws -> FirstClawContactsSearchPayload
    func add(params: FirstClawContactsAddParams) async throws -> FirstClawContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: FirstClawCalendarEventsParams) async throws -> FirstClawCalendarEventsPayload
    func add(params: FirstClawCalendarAddParams) async throws -> FirstClawCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: FirstClawRemindersListParams) async throws -> FirstClawRemindersListPayload
    func add(params: FirstClawRemindersAddParams) async throws -> FirstClawRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: FirstClawMotionActivityParams) async throws -> FirstClawMotionActivityPayload
    func pedometer(params: FirstClawPedometerParams) async throws -> FirstClawPedometerPayload
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
