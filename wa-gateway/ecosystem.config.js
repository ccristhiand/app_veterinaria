module.exports = {
  apps: [
    {
      name        : 'wa-gateway',
      script      : '/var/www/app_veterinaria/wa-gateway/src/wa-gateway.js',
      cwd         : '/var/www/app_veterinaria/wa-gateway',
      env         : { NODE_ENV: 'production' },
      watch       : false,
      max_restarts: 5,
      restart_delay: 3000,
    },
    {
      name        : 'wa-recordatorios',
      script      : '/var/www/app_veterinaria/wa-gateway/src/wa-recordatorios.js',
      cwd         : '/var/www/app_veterinaria/wa-gateway',
      env         : { NODE_ENV: 'production' },
      watch       : false,
      max_restarts: 5,
      restart_delay: 3000,
    },
    {
      name        : 'wa-campanas',
      script      : '/var/www/app_veterinaria/wa-gateway/src/wa-campanas.js',
      cwd         : '/var/www/app_veterinaria/wa-gateway',
      env         : { NODE_ENV: 'production' },
      watch       : false,
      max_restarts: 5,
      restart_delay: 3000,
    },
  ],
};