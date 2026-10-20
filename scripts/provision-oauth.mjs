// WebNNS b7a3cc3 stores OAuth configuration in the platform/cloud databases.
// Keep the old command as a migration notice; never generate replacement keys.
process.stderr.write('Генерація single.json більше не підтримується. Налаштуйте OAuth у /preference/edit головної хмари: «Єдиний публічний плагін ЛКЛАУД», центральний HTTPS origin і OAuth платформи. Клієнти ChatGPT реєструються через DCR; ключі створює users у БД. Старі ключі потрібно перенести до БД за інструкцією WebNNS до першого запуску нової версії.\n');
process.exitCode = 1;
