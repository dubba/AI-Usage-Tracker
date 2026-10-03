import { describe, expect, it } from "vitest";
import {
  classifyAndDeduplicateCameras,
  extractCameraIndex,
  isFrontFacingCamera,
  isVirtualOrPhoneCamera,
  listDesktopCameras,
  scoreCamera,
} from "./camera-selection";

const cam = (label: string, deviceId = label, kind: MediaDeviceKind = "videoinput") =>
  ({ label, deviceId, kind, groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo;
const ids = (devices: MediaDeviceInfo[]) => devices.map((d) => d.deviceId);

/** Labels as Android's Camera2 reports them on a typical multi-lens phone. */
const PHONE = [
  cam("camera2 1, facing front", "front"),
  cam("camera2 4, facing back telephoto 3x", "tele"),
  cam("camera2 2, facing back ultra wide", "ultra"),
  cam("camera2 0, facing back", "main"),
  cam("camera2 3, facing front wide", "front-wide"),
];

describe("extractCameraIndex", () => {
  it.each([
    ["camera2 3, facing back", 3],
    ["Camera 0", 0],
    ["camera 12", 12],
    ["Back Camera (2)", 2],
  ])("reads the index from %s", (label, expected) => {
    expect(extractCameraIndex(label)).toBe(expected);
  });

  it("returns null when the label has no index", () => {
    expect(extractCameraIndex("FaceTime HD Camera")).toBeNull();
    expect(extractCameraIndex("")).toBeNull();
  });
});

describe("isFrontFacingCamera", () => {
  it.each(["Front Camera", "camera2 1, facing front", "USB selfie cam", "User facing"])("treats %s as front", (label) => {
    expect(isFrontFacingCamera(cam(label))).toBe(true);
  });

  it("treats Camera2 index 1 as front unless it says it faces back", () => {
    expect(isFrontFacingCamera(cam("camera 1"))).toBe(true);
    expect(isFrontFacingCamera(cam("camera2 1, facing back"))).toBe(false);
    expect(isFrontFacingCamera(cam("camera2 1 rear"))).toBe(false);
  });

  it("does not treat other cameras as front", () => {
    expect(isFrontFacingCamera(cam("camera2 0, facing back"))).toBe(false);
    expect(isFrontFacingCamera(cam("Logitech C920"))).toBe(false);
    expect(isFrontFacingCamera(cam(""))).toBe(false);
  });
});

describe("scoreCamera", () => {
  it("ranks the main rear camera above every auxiliary lens", () => {
    const main = scoreCamera(cam("camera2 0, facing back"));
    expect(main).toBeGreaterThan(scoreCamera(cam("camera2 2, facing back ultra wide")));
    expect(main).toBeGreaterThan(scoreCamera(cam("camera2 4, facing back telephoto 3x")));
    expect(main).toBeGreaterThan(scoreCamera(cam("camera2 3, facing back macro")));
  });

  it("puts front cameras far below any rear camera", () => {
    expect(scoreCamera(cam("Front Camera"))).toBeLessThan(-500);
    expect(scoreCamera(cam("camera2 0, facing back"))).toBeGreaterThan(0);
  });

  it("prefers a camera labeled main or 1x over a plain rear one", () => {
    expect(scoreCamera(cam("Back Main Camera"))).toBeGreaterThan(scoreCamera(cam("Back Camera")));
    expect(scoreCamera(cam("Back 1x"))).toBeGreaterThan(scoreCamera(cam("Back Camera")));
  });
});

describe("classifyAndDeduplicateCameras", () => {
  it("returns a single camera, and non-camera devices removed, as they are", () => {
    const only = cam("Webcam", "w");
    expect(classifyAndDeduplicateCameras([only])).toEqual([only]);
    expect(classifyAndDeduplicateCameras([cam("Mic", "m", "audioinput")])).toEqual([]);
    expect(ids(classifyAndDeduplicateCameras([cam("Mic", "m", "audioinput"), only]))).toEqual(["w"]);
  });

  it("orders a multi-lens phone as main, ultra-wide, telephoto, then one front camera", () => {
    expect(ids(classifyAndDeduplicateCameras(PHONE))).toEqual(["main", "ultra", "tele", "front"]);
  });

  it("keeps only one front camera even when the device lists several", () => {
    const result = classifyAndDeduplicateCameras(PHONE);
    expect(result.filter(isFrontFacingCamera)).toHaveLength(1);
  });

  it("drops duplicate entries for the same device id", () => {
    const result = classifyAndDeduplicateCameras([
      cam("camera2 0, facing back", "same"),
      cam("camera2 0, facing back", "same"),
      cam("camera2 1, facing front", "front"),
    ]);
    expect(ids(result)).toEqual(["same", "front"]);
  });

  it("falls back to the label when a device has no id", () => {
    const result = classifyAndDeduplicateCameras([
      cam("camera2 0, facing back", ""),
      cam("camera2 0, facing back", ""),
      cam("camera2 2, facing back ultra wide", ""),
    ]);
    expect(result).toHaveLength(2);
  });

  it("copes with a list of only front cameras", () => {
    const result = classifyAndDeduplicateCameras([cam("camera2 1, facing front", "a"), cam("camera2 3, facing front", "b")]);
    expect(ids(result)).toEqual(["a"]);
  });

  it("does not depend on the order the browser lists the cameras in", () => {
    expect(ids(classifyAndDeduplicateCameras([...PHONE].reverse()))).toEqual(["main", "ultra", "tele", "front"]);
  });
});

describe("isVirtualOrPhoneCamera", () => {
  it.each(["Continuity Camera", "Desk View Camera", "Paul's iPhone Camera", "OBS Virtual Camera", "IR Camera", "Infrared sensor"])(
    "flags %s",
    (label) => expect(isVirtualOrPhoneCamera(cam(label))).toBe(true),
  );

  it("does not flag an ordinary webcam", () => {
    expect(isVirtualOrPhoneCamera(cam("FaceTime HD Camera"))).toBe(false);
    expect(isVirtualOrPhoneCamera(cam("Logitech BRIO"))).toBe(false);
  });
});

describe("listDesktopCameras", () => {
  it("ranks external webcams above built-in cameras, and built-in above unnamed ones", () => {
    const result = listDesktopCameras([
      cam("", "unnamed"),
      cam("FaceTime HD Camera", "builtin"),
      cam("Logitech USB Webcam", "usb"),
    ]);
    expect(ids(result)).toEqual(["usb", "builtin", "unnamed"]);
  });

  it("leaves out phone and virtual cameras when a real one exists", () => {
    const result = listDesktopCameras([cam("Paul's iPhone Camera", "phone"), cam("FaceTime HD Camera", "builtin")]);
    expect(ids(result)).toEqual(["builtin"]);
  });

  it("uses the virtual cameras when they are all there is", () => {
    expect(ids(listDesktopCameras([cam("OBS Virtual Camera", "obs")]))).toEqual(["obs"]);
  });

  it("ignores devices without an id (permission not granted yet) and non-cameras", () => {
    expect(listDesktopCameras([cam("FaceTime HD Camera", ""), cam("Mic", "m", "audioinput")])).toEqual([]);
  });

  it("does not modify the list it was given", () => {
    const input = [cam("", "a"), cam("USB Webcam", "b")];
    listDesktopCameras(input);
    expect(ids(input)).toEqual(["a", "b"]);
  });
});
