export interface MacMtpCameraOwner {
  pid: number;
  processName: string;
}

export interface MacMtpDeviceIdentity {
  vendorId: number;
  productId: number;
  serial?: string | null;
}

function numberProperty(block: string, name: string): number | null {
  const match = block.match(new RegExp(`"${name}"\\s*=\\s*(\\d+)`));
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function stringProperty(block: string, name: string): string | null {
  const match = block.match(new RegExp(`"${name}"\\s*=\\s*"([^"]*)"`));
  return match?.[1]?.trim() || null;
}

export function findMacMtpCameraOwner(
  ioregOutput: string,
  device: MacMtpDeviceIdentity
): MacMtpCameraOwner | null {
  const expectedSerial = device.serial?.trim().toLowerCase() || null;
  const interfaceBlocks = ioregOutput.split(/\n(?=\+-o )/);

  for (const block of interfaceBlocks) {
    if (
      numberProperty(block, 'bInterfaceClass') !== 6 ||
      numberProperty(block, 'bInterfaceSubClass') !== 1 ||
      numberProperty(block, 'idVendor') !== device.vendorId ||
      numberProperty(block, 'idProduct') !== device.productId
    ) {
      continue;
    }

    const interfaceSerial = stringProperty(block, 'USB Serial Number')?.toLowerCase() || null;
    if (expectedSerial && interfaceSerial && interfaceSerial !== expectedSerial) {
      continue;
    }

    const owner = block.match(/"UsbExclusiveOwner"\s*=\s*"pid\s+(\d+),\s*([^"]+)"/);
    if (!owner || owner[2].trim() !== 'ptpcamerad') {
      continue;
    }

    const pid = Number.parseInt(owner[1], 10);
    if (Number.isFinite(pid) && pid > 0) {
      return { pid, processName: owner[2].trim() };
    }
  }

  return null;
}
