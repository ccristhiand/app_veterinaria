module.exports = {
  apps: [
    {
      name         : 'wa-meta',
      script       : '/var/www/app_veterinaria/wa-meta/src/wa-meta.js',
      cwd          : '/var/www/app_veterinaria/wa-meta',
      env          : { NODE_ENV: 'production', WA_META_PORT: 5002 },
      watch        : false,
      max_restarts : 10,
      restart_delay: 3000,
    },
    {
      name         : 'wa-meta-recordatorios',
      script       : '/var/www/app_veterinaria/wa-meta/src/wa-meta-recordatorios.js',
      cwd          : '/var/www/app_veterinaria/wa-meta',
      env          : { NODE_ENV: 'production' },
      watch        : false,
      max_restarts : 5,
      restart_delay: 3000,
    },
    {
      name         : 'wa-meta-campanas',
      script       : '/var/www/app_veterinaria/wa-meta/src/wa-meta-campanas.js',
      cwd          : '/var/www/app_veterinaria/wa-meta',
      env          : { NODE_ENV: 'production' },
      watch        : false,
      max_restarts : 5,
      restart_delay: 3000,
    },
  ],
};
