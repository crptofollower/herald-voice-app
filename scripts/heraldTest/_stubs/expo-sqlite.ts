export const openDatabaseSync = () => {
  throw new Error("expo-sqlite invoked in test env - inject via setDB()");
};
export default { openDatabaseSync };
