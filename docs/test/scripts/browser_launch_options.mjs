export function browserLaunchOptions(env = process.env) {
    const channel = env.HMI_BROWSER_CHANNEL?.trim();
    const executablePath = env.HMI_BROWSER_EXECUTABLE_PATH?.trim();
    if (channel && executablePath) {
        throw new Error('Choose channel OR executablePath, not both.');
    }
    if (executablePath) return { executablePath };
    if (channel) return { channel };
    return {};
}
