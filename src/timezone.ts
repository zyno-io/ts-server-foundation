// Servers should always use UTC.
process.env.TZ = 'UTC';
if (new Date().getTimezoneOffset() !== 0) {
    throw new Error('Please restart the process with the TZ environment variable set to UTC');
}
